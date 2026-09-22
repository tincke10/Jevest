/**
 * ChangeSummarizerPort over DeepSeek's OpenAI-compatible chat-completions
 * API, the summarizer-side twin of ../reviewers/deepseek-reviewer.ts and
 * subject to the same constraint: DeepSeek supports `json_object` only, not
 * `json_schema`, so this adapter calls `create()`, states the shape in the
 * system prompt (the word "json" plus an example object, per DeepSeek's
 * json-mode contract) and validates the reply against `summaryOutputSchema`
 * itself. Empty content, truncated JSON and schema misses all surface as a
 * ReviewerParseError rather than a crash or a fake summary.
 *
 * Usage follows the reviewer adapter: `inputTokens` is the cache-MISS count
 * and `cacheReadInputTokens` the cache-HIT count so each token is billed
 * once; the OpenAI-shaped `cached_tokens` is the fallback.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type {
  ChangeSummarizerPort,
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { summaryOutputSchema, toChangeSummary } from "./summary-output-schema.js";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt } from "./summary-prompt.js";

/** The subset of the OpenAI-compatible client this adapter depends on. */
export interface DeepSeekSummaryClient {
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

export interface DeepSeekSummarizerOptions {
  readonly client: DeepSeekSummaryClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /** Default 2048 — a summary is a short object; too low truncates the JSON. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER = "deepseek";

const OUTPUT_EXAMPLE = JSON.stringify(
  {
    what_changes: "<what the change does, at most 60 words>",
    behavior_changes: ["<one observable behavior that is different>"],
    user_facing: false,
    breaking: false,
    areas: ["<product area in plain words>"],
    risks: ["<one concrete risk visible in the diff>"],
  },
  null,
  2,
);

/**
 * The shared summary instructions plus DeepSeek's json-mode requirements:
 * the word "json", an example object and the field rules in prose, since
 * a json_object response has no server-side schema enforcement.
 */
export const DEEPSEEK_SUMMARY_SYSTEM_PROMPT = `${SUMMARY_SYSTEM_PROMPT}

Output format: respond with a single JSON object and nothing else — no prose, no markdown fences. It must have exactly this shape:
${OUTPUT_EXAMPLE}

Rules for the JSON:
- "what_changes" is a non-empty string.
- "behavior_changes", "areas" and "risks" are always arrays of strings; an empty array is allowed.
- "user_facing" and "breaking" are booleans.`;

function parseSummaryJson(content: string | null | undefined, prId: string) {
  const text = content?.trim() ?? "";
  if (text === "") {
    throw new ReviewerParseError(PROVIDER, prId);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReviewerParseError(PROVIDER, prId);
  }
  const result = summaryOutputSchema.safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, prId);
  }
  return result.data;
}

export function createDeepSeekSummarizer(options: DeepSeekSummarizerOptions): ChangeSummarizerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      const start = now();
      let response: Awaited<ReturnType<DeepSeekSummaryClient["chat"]["completions"]["create"]>>;
      try {
        response = await options.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: DEEPSEEK_SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: buildSummaryUserPrompt(input) },
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
          // 402 is DeepSeek's "Insufficient Balance", same as the reviewer adapter.
          const type = error.status === 402 ? "insufficient_balance" : error.type;
          throw new ReviewerApiError(PROVIDER, error.status, type, error);
        }
        throw error;
      }
      const latencyMs = now() - start;

      const parsed = parseSummaryJson(response.choices[0]?.message.content, input.prId);

      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHit =
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);

      return {
        summary: toChangeSummary(parsed),
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
