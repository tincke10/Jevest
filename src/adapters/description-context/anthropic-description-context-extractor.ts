/**
 * DescriptionContextPort over the official `@anthropic-ai/sdk`, the
 * extractor-side twin of ../narrators/anthropic-narrator.ts: same
 * `messages.parse()` + `zodOutputFormat` structured output, cached system
 * prompt and error taxonomy. Effort defaults to "low": pulling a handful
 * of sentences out of a description needs far less thinking than a review.
 */
import { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages.js";
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
  type DescriptionContextOutputSchema,
  descriptionContextOutputSchema,
  toExtractedAuthorContext,
} from "./description-context-output-schema.js";
import {
  DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
  buildDescriptionContextUserPrompt,
} from "./description-context-prompt.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the Anthropic client this adapter depends on. */
export interface AnthropicDescriptionContextClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
      messages: Array<{ role: "user"; content: string }>;
      output_config: { format: JSONOutputFormat | null; effort?: Effort };
    }): Promise<{
      id: string;
      model: string;
      parsed_output: DescriptionContextOutputSchema | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
      };
    }>;
  };
}

export interface AnthropicDescriptionContextOptions {
  readonly client: AnthropicDescriptionContextClient;
  /** Default "claude-sonnet-5". */
  readonly model?: string;
  /** Default "low". */
  readonly effort?: Effort;
  /** Default 2048 — a dozen short items plus the thinking before them. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT: Effort = "low";
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER = "anthropic";

const OUTPUT_FORMAT = zodOutputFormat(descriptionContextOutputSchema);

export function createAnthropicDescriptionContextExtractor(
  options: AnthropicDescriptionContextOptions,
): DescriptionContextPort {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async extract(input: DescriptionContextInput): Promise<DescriptionContextOutput> {
      const start = now();
      let response: Awaited<ReturnType<AnthropicDescriptionContextClient["messages"]["parse"]>>;
      try {
        response = await options.client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [
            {
              type: "text",
              text: DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: buildDescriptionContextUserPrompt(input) }],
          output_config: { format: OUTPUT_FORMAT, effort },
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
          throw new ReviewerApiError(PROVIDER, error.status, error.type, error);
        }
        throw error;
      }
      const latencyMs = now() - start;

      if (response.parsed_output === null) {
        throw new ReviewerParseError(PROVIDER, input.prId);
      }

      return {
        ...toExtractedAuthorContext(response.parsed_output),
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        latencyMs,
        requestId: response.id,
      };
    },
  };
}
