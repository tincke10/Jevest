/**
 * ReviewerPort over the official `openai` SDK (SPEC FR-4, §5 Fase 1a step 1,
 * §13 "LLM revisor y juez: ambos proveedores"). Structured output via
 * `client.chat.completions.parse()` with `zodResponseFormat`, the OpenAI
 * chat-completions equivalent of the Anthropic adapter's `messages.parse()`.
 *
 * Model defaults to `gpt-5.6-luna`, confirmed present in this repo's
 * installed `openai` SDK's `ChatModel` type union (per the task brief, this
 * is what the LangChain article used; the installed SDK's own types confirm
 * it's a real, current model id rather than a guess).
 *
 * The SDK client is always injected (`options.client`), narrowed to the one
 * method this adapter calls, matching the Anthropic adapter and
 * ../typesafe-decision-adapter.ts's `DecisionApiClient` pattern.
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import {
  type ReviewOutputSchema,
  reviewOutputSchema,
  toReviewFindingCandidates,
} from "./review-output-schema.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./review-prompt.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "./reviewer-errors.js";

/** The subset of the OpenAI client this adapter depends on. */
export interface OpenAiChatClient {
  chat: {
    completions: {
      parse(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: ReturnType<typeof zodResponseFormat<typeof reviewOutputSchema>>;
      }): Promise<{
        id: string;
        model: string;
        choices: Array<{ message: { parsed: ReviewOutputSchema | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      }>;
    };
  };
}

export interface OpenAiReviewerOptions {
  readonly client: OpenAiChatClient;
  /** Default REVIEW_SYSTEM_PROMPT (strict); `reviewSystemPromptFor("thorough")` for the low-bar pass. */
  readonly systemPrompt?: string;
  /** Default "gpt-5.6-luna" (confirmed in the installed SDK's ChatModel union). */
  readonly model?: string;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "gpt-5.6-luna";
const PROVIDER = "openai";
const RESPONSE_FORMAT = zodResponseFormat(reviewOutputSchema, "review_output");

export function createOpenAiReviewer(options: OpenAiReviewerOptions): ReviewerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const now = options.now ?? Date.now;
  const systemPrompt = options.systemPrompt ?? REVIEW_SYSTEM_PROMPT;

  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const start = now();
      let response: Awaited<ReturnType<OpenAiChatClient["chat"]["completions"]["parse"]>>;
      try {
        response = await options.client.chat.completions.parse({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: buildReviewUserPrompt(input) },
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
        throw new ReviewerParseError(PROVIDER, input.hunkId);
      }

      return {
        findings: toReviewFindingCandidates(parsed),
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
