/**
 * FindingJudgePort over DeepSeek's OpenAI-compatible chat-completions API,
 * the judge-side twin of ../reviewers/deepseek-reviewer.ts (SPEC §13,
 * 2026-09-22 rule: the Claude subscription is reserved for reviews; every
 * other LLM call in Jevest goes through DeepSeek). Same client shape, same
 * `json_object`-only structured output validated client-side (here against
 * judge-output-schema.ts), same usage split (cache-miss tokens as
 * `inputTokens`, cache-hit as `cacheReadInputTokens`) and the same error
 * mapping onto ../reviewers/reviewer-errors.ts. Empty or truncated content
 * is a ReviewerParseError, never a silent default judgment.
 *
 * No `nominalCostUsd`: DeepSeek is per-token billed, so the judge runner
 * prices `usage` with `pricingForModel(output.model)`.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { judgeOutputSchema, toFindingJudgment } from "./judge-output-schema.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from "./judge-prompt.js";

/** The subset of the OpenAI-compatible client this adapter depends on (same as the reviewer's). */
export interface DeepSeekJudgeChatClient {
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

export interface DeepSeekFindingJudgeOptions {
  readonly client: DeepSeekJudgeChatClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /** Default 1024 — one small JSON object; too low truncates it. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 1024;
const PROVIDER = "deepseek";

const OUTPUT_EXAMPLE = JSON.stringify(
  {
    is_real_defect_probability: 0.8,
    severity: "major",
    is_style_only: false,
    actionable: true,
  },
  null,
  2,
);

/**
 * The shared judge prompt plus DeepSeek's json-mode requirements: the word
 * "json", an example object and the allowed values, stated in prose since
 * json_object has no server-side schema enforcement.
 */
export const DEEPSEEK_JUDGE_SYSTEM_PROMPT = `${JUDGE_SYSTEM_PROMPT}

Output format: respond with a single JSON object and nothing else — no prose, no markdown fences. It must have exactly this shape:
${OUTPUT_EXAMPLE}

Rules for the JSON:
- "is_real_defect_probability" is a number between 0 and 1 inclusive.
- "severity" is exactly one of: "nit", "minor", "major", "critical".
- "is_style_only" and "actionable" are booleans.`;

function parseJudgeJson(content: string | null | undefined, findingId: string) {
  const text = content?.trim() ?? "";
  if (text === "") {
    throw new ReviewerParseError(PROVIDER, findingId);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReviewerParseError(PROVIDER, findingId);
  }
  const result = judgeOutputSchema.safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, findingId);
  }
  return result.data;
}

export function createDeepSeekFindingJudge(options: DeepSeekFindingJudgeOptions): FindingJudgePort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async judge(input: FindingJudgeInput): Promise<FindingJudgeOutput> {
      const start = now();
      let response: Awaited<ReturnType<DeepSeekJudgeChatClient["chat"]["completions"]["create"]>>;
      try {
        response = await options.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: DEEPSEEK_JUDGE_SYSTEM_PROMPT },
            { role: "user", content: buildJudgeUserPrompt(input) },
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

      const parsed = parseJudgeJson(response.choices[0]?.message.content, input.findingId);

      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHit =
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);

      return {
        judgment: toFindingJudgment(parsed),
        model: response.model,
        usage: {
          inputTokens: cacheMiss,
          outputTokens: usage?.completion_tokens ?? 0,
          cacheReadInputTokens: cacheHit,
          cacheCreationInputTokens: 0,
        },
        latencyMs,
        requestId: response.id,
      };
    },
  };
}
