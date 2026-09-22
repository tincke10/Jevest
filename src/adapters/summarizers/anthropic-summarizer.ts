/**
 * ChangeSummarizerPort over the official `@anthropic-ai/sdk`, the
 * summarizer-side twin of ../reviewers/anthropic-reviewer.ts: same
 * `messages.parse()` + `zodOutputFormat` structured output, same cached
 * system prompt (`cache_control: ephemeral` — the summary prompt repeats
 * byte-for-byte across PRs), same `output_config.effort` cost control
 * instead of `budget_tokens`, same error taxonomy. Only the schema, the
 * prompt and the user message differ.
 *
 * Default model is `claude-sonnet-5`, not Opus: the summary is a per-PR
 * enhancer of triage (H7), and the reviewer's model is what the consumer
 * pays attention to; composition roots pass `reviewer.model` explicitly
 * anyway. The user message is built from files and patches only (see
 * summary-prompt.ts and the port for why the PR id and narrative never
 * reach the model).
 */
import { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages.js";
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
import {
  type SummaryOutputSchema,
  summaryOutputSchema,
  toChangeSummary,
} from "./summary-output-schema.js";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt } from "./summary-prompt.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the Anthropic client this adapter depends on. */
export interface AnthropicSummaryClient {
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
      parsed_output: SummaryOutputSchema | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
      };
    }>;
  };
}

export interface AnthropicSummarizerOptions {
  readonly client: AnthropicSummaryClient;
  /** Default "claude-sonnet-5". */
  readonly model?: string;
  /** Default "medium" — cost control; thinking stays on regardless. */
  readonly effort?: Effort;
  /** Default 2048 — a summary is a short structured object. */
  readonly maxTokens?: number;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT: Effort = "medium";
const DEFAULT_MAX_TOKENS = 2048;
const PROVIDER = "anthropic";

const OUTPUT_FORMAT = zodOutputFormat(summaryOutputSchema);

export function createAnthropicSummarizer(
  options: AnthropicSummarizerOptions,
): ChangeSummarizerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? Date.now;

  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      const start = now();
      let response: Awaited<ReturnType<AnthropicSummaryClient["messages"]["parse"]>>;
      try {
        response = await options.client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [
            { type: "text", text: SUMMARY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: buildSummaryUserPrompt(input) }],
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
        summary: toChangeSummary(response.parsed_output),
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
