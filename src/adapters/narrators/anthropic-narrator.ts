/**
 * ReviewNarratorPort over the official `@anthropic-ai/sdk`, the
 * narrator-side twin of ../summarizers/anthropic-summarizer.ts: same
 * `messages.parse()` + `zodOutputFormat` structured output (a one-field
 * `{review}` schema), same cached system prompt, same `output_config.effort`
 * cost control instead of `budget_tokens`, same error taxonomy.
 *
 * Default model is `claude-sonnet-5` like the summarizer; composition roots
 * pass `reviewer.model` explicitly anyway.
 */
import { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages.js";
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
import {
  type NarrativeOutputSchema,
  narrativeOutputSchema,
  toNarrativeMarkdown,
} from "./narrative-output-schema.js";
import { NARRATIVE_SYSTEM_PROMPT, buildNarrativeUserPrompt } from "./narrative-prompt.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the Anthropic client this adapter depends on. */
export interface AnthropicNarrativeClient {
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
      parsed_output: NarrativeOutputSchema | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
      };
    }>;
  };
}

export interface AnthropicNarratorOptions {
  readonly client: AnthropicNarrativeClient;
  /** Default "claude-sonnet-5". */
  readonly model?: string;
  /** Default "medium" — cost control; thinking stays on regardless. */
  readonly effort?: Effort;
  /** Default 4096 — a short review plus the thinking that precedes it. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT: Effort = "medium";
const DEFAULT_MAX_TOKENS = 4096;
const PROVIDER = "anthropic";

const OUTPUT_FORMAT = zodOutputFormat(narrativeOutputSchema);

export function createAnthropicNarrator(options: AnthropicNarratorOptions): ReviewNarratorPort {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async narrate(input: ReviewNarrativeInput): Promise<ReviewNarrativeOutput> {
      const start = now();
      let response: Awaited<ReturnType<AnthropicNarrativeClient["messages"]["parse"]>>;
      try {
        response = await options.client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [
            { type: "text", text: NARRATIVE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: buildNarrativeUserPrompt(input) }],
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
        markdown: toNarrativeMarkdown(response.parsed_output),
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
