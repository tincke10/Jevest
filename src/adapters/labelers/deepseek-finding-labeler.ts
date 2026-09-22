/**
 * FindingLabelerPort over DeepSeek's OpenAI-compatible chat-completions API,
 * the oracle-labeler twin of ../judges/deepseek-finding-judge.ts (SPEC §13:
 * the Claude subscription is reserved for reviews; every other LLM call in
 * Jevest goes through DeepSeek). Same client shape, same `json_object`-only
 * structured output validated client-side, same usage split (cache-miss
 * tokens as `inputTokens`, cache-hit as `cacheReadInputTokens`) and the same
 * error mapping onto ../reviewers/reviewer-errors.ts.
 *
 * A verdict from the WRONG framing is a ReviewerParseError, not a coerced
 * answer: the whole design rests on the two passes being asked different
 * questions, so a pass that drifted into the other's vocabulary has not
 * answered the question it was asked.
 *
 * No `nominalCostUsd`: DeepSeek is per-token billed, so the oracle runner
 * prices `usage` with `pricingForModel(output.model)`.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type {
  ClaimVerificationOutput,
  FindingLabelerInput,
  FindingLabelerPort,
  FixMatchOutput,
  LabelerFraming,
} from "../../domain/ports/finding-labeler-port.js";
import type { ReviewUsage } from "../../domain/ports/reviewer-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { labelerOutputSchemaFor } from "./labeler-output-schema.js";
import {
  CLAIM_VERIFICATION_SYSTEM_PROMPT,
  FIX_MATCH_SYSTEM_PROMPT,
  buildLabelerUserPrompt,
} from "./labeler-prompt.js";

/** The subset of the OpenAI-compatible client this adapter depends on (same as the judge's). */
export interface DeepSeekLabelerChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: { type: "json_object" };
        max_tokens: number;
      }): Promise<{
        id: string;
        model: string;
        choices: Array<{
          message: { content: string | null };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      }>;
    };
  };
}

export interface DeepSeekFindingLabelerOptions {
  readonly client: DeepSeekLabelerChatClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /**
   * Default 8192, for the reason measured on the judge (commit d12fede):
   * deepseek-v4-pro is a reasoning model and its `reasoning_content` tokens
   * count against `max_tokens`, so a "one small JSON object" budget truncates
   * most real inputs before the JSON begins. The labeler's input is larger
   * still (before + after + commit message + issue), so this is a floor.
   */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 8192;
const PROVIDER = "deepseek";

function outputExample(verdict: string): string {
  return JSON.stringify(
    { verdict, confidence: 0.8, reason: "one sentence naming what decided it" },
    null,
    2,
  );
}

function jsonModeSuffix(verdicts: readonly string[], example: string): string {
  return `

Output format: respond with a single JSON object and nothing else — no prose, no markdown fences. It must have exactly this shape:
${example}

Rules for the JSON:
- "verdict" is exactly one of: ${verdicts.map((v) => `"${v}"`).join(", ")}.
- "confidence" is a number between 0 and 1 inclusive.
- "reason" is a single sentence.`;
}

/** Pass A's shared prompt plus DeepSeek's json-mode requirements (the word "json", an example, the allowed values). */
export const DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT = `${FIX_MATCH_SYSTEM_PROMPT}${jsonModeSuffix(
  ["real", "not-this", "unclear"],
  outputExample("real"),
)}`;

/** Pass B's shared prompt plus the same json-mode requirements. */
export const DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT = `${CLAIM_VERIFICATION_SYSTEM_PROMPT}${jsonModeSuffix(
  ["present", "absent", "unclear"],
  outputExample("present"),
)}`;

function systemPromptFor(framing: LabelerFraming): string {
  return framing === "fix-match"
    ? DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT
    : DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT;
}

function parseLabelerJson(
  content: string | null | undefined,
  findingId: string,
  framing: LabelerFraming,
  finishReason: string | null | undefined,
  maxTokens: number,
): { verdict: string; confidence: number; reason: string } {
  // Name the truncation: a "length" finish with broken JSON is the model's
  // reasoning eating the budget, not a schema problem, and the fix differs.
  const detail =
    finishReason === "length"
      ? `truncated at max_tokens=${maxTokens} (finish_reason=length)`
      : `framing=${framing}`;
  const text = content?.trim() ?? "";
  if (text === "") {
    throw new ReviewerParseError(PROVIDER, findingId, detail);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReviewerParseError(PROVIDER, findingId, detail);
  }
  const result = labelerOutputSchemaFor(framing).safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, findingId, detail);
  }
  return result.data;
}

function splitUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}): ReviewUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);
  return {
    inputTokens: cacheMiss,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadInputTokens: cacheHit,
    cacheCreationInputTokens: 0,
  };
}

const EMPTY_USAGE: ReviewUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function createDeepSeekFindingLabeler(
  options: DeepSeekFindingLabelerOptions,
): FindingLabelerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  async function call(input: FindingLabelerInput, framing: LabelerFraming) {
    const start = now();
    let response: Awaited<ReturnType<DeepSeekLabelerChatClient["chat"]["completions"]["create"]>>;
    try {
      response = await options.client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPromptFor(framing) },
          { role: "user", content: buildLabelerUserPrompt(input) },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
      });
    } catch (error) {
      // Most-specific first: RateLimitError and AuthenticationError both
      // extend APIError, so a generic APIError check must come last.
      if (error instanceof RateLimitError) {
        throw new ReviewerRateLimitError(PROVIDER, error);
      }
      if (error instanceof AuthenticationError) {
        throw new ReviewerAuthenticationError(PROVIDER, error);
      }
      if (error instanceof APIError) {
        // 402 is DeepSeek's "Insufficient Balance": name it so the run says "top up".
        const type = error.status === 402 ? "insufficient_balance" : error.type;
        throw new ReviewerApiError(PROVIDER, error.status, type, error);
      }
      throw error;
    }
    const latencyMs = now() - start;

    const choice = response.choices[0];
    const parsed = parseLabelerJson(
      choice?.message.content,
      input.findingId,
      framing,
      choice?.finish_reason,
      maxTokens,
    );

    return {
      framing,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reason: parsed.reason,
      model: response.model,
      usage: response.usage ? splitUsage(response.usage) : EMPTY_USAGE,
      latencyMs,
      requestId: response.id,
    };
  }

  return {
    async labelFixMatch(input: FindingLabelerInput): Promise<FixMatchOutput> {
      return (await call(input, "fix-match")) as FixMatchOutput;
    },
    async labelClaimVerification(input: FindingLabelerInput): Promise<ClaimVerificationOutput> {
      return (await call(input, "claim-verification")) as ClaimVerificationOutput;
    },
  };
}
