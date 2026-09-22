/**
 * ChangeSummarizerPort over the official `openai` SDK, the summarizer-side
 * twin of ../reviewers/openai-reviewer.ts: `chat.completions.parse()` with
 * `zodResponseFormat` (server-enforced schema), same error mapping. Only
 * the schema, the system prompt and the user message differ, and the user
 * message is built from files and patches only (see summary-prompt.ts).
 */
import { APIError, AuthenticationError, RateLimitError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
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

/** The subset of the OpenAI client this adapter depends on. */
export interface OpenAiSummaryClient {
  chat: {
    completions: {
      parse(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: ReturnType<typeof zodResponseFormat<typeof summaryOutputSchema>>;
      }): Promise<{
        id: string;
        model: string;
        choices: Array<{ message: { parsed: SummaryOutputSchema | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      }>;
    };
  };
}

export interface OpenAiSummarizerOptions {
  readonly client: OpenAiSummaryClient;
  /** Default "gpt-5.6-luna", same as the reviewer. */
  readonly model?: string;
  /** Injectable clock for deterministic latency tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "gpt-5.6-luna";
const PROVIDER = "openai";
const RESPONSE_FORMAT = zodResponseFormat(summaryOutputSchema, "change_summary");

export function createOpenAiSummarizer(options: OpenAiSummarizerOptions): ChangeSummarizerPort {
  const model = options.model ?? DEFAULT_MODEL;
  const now = options.now ?? Date.now;

  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      const start = now();
      let response: Awaited<ReturnType<OpenAiSummaryClient["chat"]["completions"]["parse"]>>;
      try {
        response = await options.client.chat.completions.parse({
          model,
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: buildSummaryUserPrompt(input) },
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
        summary: toChangeSummary(parsed),
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
