/**
 * ReviewerPort over the official `@anthropic-ai/sdk` (SPEC FR-4, §5 Fase 1a
 * step 1). Model `claude-opus-5`: thinking is on by default and must NOT be
 * configured with `budget_tokens` (400 on Opus 5); cost is kept down with
 * `output_config.effort: "medium"` instead. No assistant prefill (400 on
 * Opus 5) — every request is a single user turn. Structured output uses
 * `client.messages.parse()` with `zodOutputFormat` (see
 * review-output-schema.ts), never hand-rolled JSON parsing of free text.
 *
 * The system prompt is marked `cache_control: { type: "ephemeral" }` because
 * it repeats byte-for-byte across every hunk in a run; `usage.cache_read_input_tokens`
 * on the response is how a caller verifies the cache is actually being hit.
 *
 * The SDK client is always injected (`options.client`), narrowed to the one
 * method this adapter calls — same pattern as `DecisionApiClient` in
 * ../typesafe-decision-adapter.ts — so tests never touch the real SDK.
 */
import { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages.js";
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

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the Anthropic client this adapter depends on. */
export interface AnthropicMessagesClient {
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
      parsed_output: ReviewOutputSchema | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
      };
    }>;
  };
}

export interface AnthropicReviewerOptions {
  readonly client: AnthropicMessagesClient;
  /** Default "claude-opus-5" (SPEC decision, see docs/SPEC.md §13). */
  readonly model?: string;
  /** Default "medium" — cost control; thinking stays on regardless (Opus 5 default). */
  readonly effort?: Effort;
  /** Default 4096 — findings are short structured output. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT: Effort = "medium";
const DEFAULT_MAX_TOKENS = 4096;
const PROVIDER = "anthropic";

const OUTPUT_FORMAT = zodOutputFormat(reviewOutputSchema);

export function createAnthropicReviewer(options: AnthropicReviewerOptions): ReviewerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const start = now();
      let response: Awaited<ReturnType<AnthropicMessagesClient["messages"]["parse"]>>;
      try {
        response = await options.client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [
            { type: "text", text: REVIEW_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: buildReviewUserPrompt(input) }],
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
        throw new ReviewerParseError(PROVIDER, input.hunkId);
      }

      return {
        findings: toReviewFindingCandidates(response.parsed_output),
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
