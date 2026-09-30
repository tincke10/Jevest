/**
 * DescriptionContextPort over the official `openai` SDK, the extractor-side
 * twin of ../narrators/openai-narrator.ts: `chat.completions.parse()` with
 * `zodResponseFormat`, same error mapping.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
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

/** The subset of the OpenAI client this adapter depends on. */
export interface OpenAiDescriptionContextClient {
  chat: {
    completions: {
      parse(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: ReturnType<
          typeof zodResponseFormat<typeof descriptionContextOutputSchema>
        >;
      }): Promise<{
        id: string;
        model: string;
        choices: Array<{ message: { parsed: DescriptionContextOutputSchema | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      }>;
    };
  };
}

export interface OpenAiDescriptionContextOptions {
  readonly client: OpenAiDescriptionContextClient;
  /** Default "gpt-5.6-luna", same as the reviewer. */
  readonly model?: string;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "gpt-5.6-luna";
const PROVIDER = "openai";
const RESPONSE_FORMAT = zodResponseFormat(descriptionContextOutputSchema, "description_context");

export function createOpenAiDescriptionContextExtractor(
  options: OpenAiDescriptionContextOptions,
): DescriptionContextPort {
  const model = options.model ?? DEFAULT_MODEL;
  const now = options.now ?? Date.now;

  return {
    async extract(input: DescriptionContextInput): Promise<DescriptionContextOutput> {
      const start = now();
      let response: Awaited<
        ReturnType<OpenAiDescriptionContextClient["chat"]["completions"]["parse"]>
      >;
      try {
        response = await options.client.chat.completions.parse({
          model,
          messages: [
            { role: "system", content: DESCRIPTION_CONTEXT_SYSTEM_PROMPT },
            { role: "user", content: buildDescriptionContextUserPrompt(input) },
          ],
          response_format: RESPONSE_FORMAT,
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

      const parsed = response.choices[0]?.message.parsed ?? null;
      if (parsed === null) {
        throw new ReviewerParseError(PROVIDER, input.prId);
      }

      return {
        ...toExtractedAuthorContext(parsed),
        model: response.model,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs,
        requestId: response.id,
      };
    },
  };
}
