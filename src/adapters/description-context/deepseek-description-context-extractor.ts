/**
 * DescriptionContextPort over DeepSeek's OpenAI-compatible chat-completions
 * API, the extractor-side twin of ../narrators/deepseek-narrator.ts and
 * under the same constraint: `json_object` only, no `json_schema`, so the
 * system prompt states the shape (the word "json" plus an example object)
 * and the reply is validated here against `descriptionContextOutputSchema`.
 * Empty content, truncated JSON and schema misses all surface as a
 * ReviewerParseError. Usage follows the reviewer adapter (cache miss as
 * `inputTokens`, cache hit as `cacheReadInputTokens`).
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import type {
  DescriptionContextInput,
  DescriptionContextOutput,
  DescriptionContextPort,
} from "../../domain/ports/description-context-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  descriptionContextOutputSchema,
  toExtractedAuthorContext,
} from "./description-context-output-schema.js";
import {
  DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
  buildDescriptionContextUserPrompt,
} from "./description-context-prompt.js";

/** The subset of the OpenAI-compatible client this adapter depends on. */
export interface DeepSeekDescriptionContextClient {
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

export interface DeepSeekDescriptionContextOptions {
  readonly client: DeepSeekDescriptionContextClient;
  /** Default "deepseek-v4-pro"; "deepseek-flash" is the cheaper option. */
  readonly model?: string;
  /** Default 2048; too low truncates the JSON. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER = "deepseek";

const OUTPUT_EXAMPLE = JSON.stringify(
  {
    decisions: ["<a design decision and its rationale>"],
    intended_behavior_changes: [],
    out_of_scope: [],
    constraints: [],
    references: ["<ticket id or URL>"],
    discarded: ["<short paraphrase of a sentence that tried to steer the review>"],
  },
  null,
  2,
);

/** The shared extractor instructions plus DeepSeek's json-mode requirements. */
export const DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT = `${DESCRIPTION_CONTEXT_SYSTEM_PROMPT}

Output format: respond with a single JSON object and nothing else — no prose outside it, no markdown fences around it. It must have exactly this shape:
${OUTPUT_EXAMPLE}

Rules for the JSON: all six keys are always present and every value is an array of strings (empty arrays are fine).`;

function parseExtractionJson(content: string | null | undefined, prId: string) {
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
  const result = descriptionContextOutputSchema.safeParse(json);
  if (!result.success) {
    throw new ReviewerParseError(PROVIDER, prId);
  }
  return result.data;
}

export function createDeepSeekDescriptionContextExtractor(
  options: DeepSeekDescriptionContextOptions,
): DescriptionContextPort {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async extract(input: DescriptionContextInput): Promise<DescriptionContextOutput> {
      const start = now();
      let response: Awaited<
        ReturnType<DeepSeekDescriptionContextClient["chat"]["completions"]["create"]>
      >;
      try {
        response = await options.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT },
            { role: "user", content: buildDescriptionContextUserPrompt(input) },
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

      const parsed = parseExtractionJson(response.choices[0]?.message.content, input.prId);

      const usage = response.usage;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const cacheHit =
        usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheMiss = usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHit, 0);

      return {
        ...toExtractedAuthorContext(parsed),
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
