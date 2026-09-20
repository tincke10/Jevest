/**
 * ReviewerPort over DeepSeek's OpenAI-compatible chat-completions API
 * (SPEC FR-4; §13 decision 2026-09-20 "tercer proveedor"). Reuses the
 * `openai` SDK client pointed at {@link DEEPSEEK_BASE_URL}; DeepSeek
 * returns the same HTTP error codes, so the SDK's typed errors map onto
 * ./reviewer-errors.ts exactly as in openai-reviewer.ts.
 *
 * Why NOT a copy of openai-reviewer.ts: DeepSeek's structured output is
 * `response_format: { type: "json_object" }` only — the `json_schema`
 * variant that `chat.completions.parse()` + `zodResponseFormat` send is
 * not supported (https://api-docs.deepseek.com/guides/json_mode). So this
 * adapter calls `create()`, asks for a JSON object, and validates the
 * returned text against `reviewOutputSchema` itself. DeepSeek's json mode
 * contract: the word "json" must appear in the prompt together with an
 * example of the expected object (both live in {@link DEEPSEEK_SYSTEM_PROMPT}),
 * `max_tokens` must be set high enough that the object isn't truncated,
 * and the API "may occasionally return empty content" — each of those
 * failure modes surfaces as a ReviewerParseError rather than a crash.
 *
 * Usage: DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * (its context-caching split) on top of the standard `prompt_tokens`.
 * `inputTokens` here is the cache-MISS count and `cacheReadInputTokens`
 * the cache-HIT count, so `reviewCostUsd` bills each token exactly once.
 * The OpenAI-shaped `prompt_tokens_details.cached_tokens` is the fallback.
 *
 * The SDK client is always injected (`options.client`), narrowed to the one
 * method this adapter calls, matching the other reviewer adapters.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import { reviewOutputSchema, toReviewFindingCandidates } from "./review-output-schema.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./review-prompt.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "./reviewer-errors.js";

/** OpenAI-compatible endpoint; pass as `baseURL` when constructing the `openai` client. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** The subset of the OpenAI-compatible client this adapter depends on. */
export interface DeepSeekChatClient {
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

export interface DeepSeekReviewerOptions {
  readonly client: DeepSeekChatClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /** Default 4096 — findings are short structured output; too low truncates the JSON. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 4096;
const PROVIDER = "deepseek";

const OUTPUT_EXAMPLE = JSON.stringify(
  {
    findings: [
      {
        line_start: 42,
        line_end: 43,
        claim: "<one-sentence defect claim>",
        rationale: "<why this is a defect, pointing at the code>",
        suggested_severity: "minor",
      },
    ],
  },
  null,
  2,
);

/**
 * The shared reviewer instructions plus DeepSeek's json-mode requirements:
 * the word "json", an example object, and the allowed enum values (a
 * json_object response is free-form JSON, so the schema has to be stated
 * in prose — there is no server-side schema enforcement here).
 */
export const DEEPSEEK_SYSTEM_PROMPT = `${REVIEW_SYSTEM_PROMPT}

Output format: respond with a single JSON object and nothing else — no prose, no markdown fences. It must have exactly this shape:
${OUTPUT_EXAMPLE}

Rules for the JSON:
- "findings" is always an array; when there is no concrete defect, return {"findings": []}.
- "line_start" and "line_end" are integers (BEFORE-side absolute line numbers, as described above).
- "claim" and "rationale" are non-empty strings.
- "suggested_severity" is exactly one of: "nit", "minor", "major", "critical".`;

function parseReviewJson(content: string | null | undefined, hunkId: string) {
  const text = content?.trim() ?? "";
  if (text === "") {
    throw new ReviewerParseError(PROVIDER, hunkId);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReviewerParseError(PROVIDER, hunkId);
  }
  const result = reviewOutputSchema.safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, hunkId);
  }
  return result.data;
}

export function createDeepSeekReviewer(options: DeepSeekReviewerOptions): ReviewerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const start = now();
      let response: Awaited<ReturnType<DeepSeekChatClient["chat"]["completions"]["create"]>>;
      try {
        response = await options.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: DEEPSEEK_SYSTEM_PROMPT },
            { role: "user", content: buildReviewUserPrompt(input) },
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
          // 402 is DeepSeek's "Insufficient Balance": the account has no
          // credit left. Name it so the run summary says "top up", not "API error".
          const type = error.status === 402 ? "insufficient_balance" : error.type;
          throw new ReviewerApiError(PROVIDER, error.status, type, error);
        }
        throw error;
      }
      const latencyMs = now() - start;

      const parsed = parseReviewJson(response.choices[0]?.message.content, input.hunkId);

      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHit =
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);

      return {
        findings: toReviewFindingCandidates(parsed),
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
