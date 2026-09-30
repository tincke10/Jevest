/**
 * ReviewNarratorPort over DeepSeek's OpenAI-compatible chat-completions API,
 * the narrator-side twin of ../summarizers/deepseek-summarizer.ts and under
 * the same constraint: `json_object` only, no `json_schema`, so the system
 * prompt states the shape (the word "json" plus an example object) and the
 * reply is validated here against `narrativeOutputSchema`. Empty content,
 * truncated JSON and schema misses all surface as a ReviewerParseError.
 *
 * Usage follows the reviewer adapter: `inputTokens` is the cache-MISS count
 * and `cacheReadInputTokens` the cache-HIT count, so each token is billed
 * once; the OpenAI-shaped `cached_tokens` is the fallback.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type {
  ReviewNarrativeInput,
  ReviewNarrativeOutput,
  ReviewNarratorPort,
} from "../../domain/ports/review-narrator-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { narrativeOutputSchema, toNarrativeMarkdown } from "./narrative-output-schema.js";
import { NARRATIVE_SYSTEM_PROMPT, buildNarrativeUserPrompt } from "./narrative-prompt.js";

/** The subset of the OpenAI-compatible client this adapter depends on. */
export interface DeepSeekNarrativeClient {
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

export interface DeepSeekNarratorOptions {
  readonly client: DeepSeekNarrativeClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /** Default 2048 — a short review; too low truncates the JSON. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER = "deepseek";

const OUTPUT_EXAMPLE = JSON.stringify(
  { review: "<the whole review, as markdown, in the requested language>" },
  null,
  2,
);

/** The shared narrative instructions plus DeepSeek's json-mode requirements. */
export const DEEPSEEK_NARRATIVE_SYSTEM_PROMPT = `${NARRATIVE_SYSTEM_PROMPT}

Output format: respond with a single JSON object and nothing else — no prose outside it, no markdown fences around it. It must have exactly this shape:
${OUTPUT_EXAMPLE}

Rules for the JSON: "review" is a non-empty string; newlines inside it are escaped as \\n.`;

function parseNarrativeJson(content: string | null | undefined, prId: string) {
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
  const result = narrativeOutputSchema.safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, prId);
  }
  return result.data;
}

export function createDeepSeekNarrator(options: DeepSeekNarratorOptions): ReviewNarratorPort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async narrate(input: ReviewNarrativeInput): Promise<ReviewNarrativeOutput> {
      const start = now();
      let response: Awaited<ReturnType<DeepSeekNarrativeClient["chat"]["completions"]["create"]>>;
      try {
        response = await options.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: DEEPSEEK_NARRATIVE_SYSTEM_PROMPT },
            { role: "user", content: buildNarrativeUserPrompt(input) },
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

      const parsed = parseNarrativeJson(response.choices[0]?.message.content, input.prId);

      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHit =
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);

      return {
        markdown: toNarrativeMarkdown(parsed),
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
