/**
 * Real DecisionPort over `@typesafe-ai/sdk` (SPEC §7, NFR-1, NFR-2). Maps
 * domain Questions to SDK question builders and SDK answers back to domain
 * Decisions, measures client-side latency, and owns its own retry policy
 * (exponential backoff + jitter) so it can be driven by an injectable
 * clock/sleep in tests instead of the SDK's internal timers.
 *
 * The SDK client is always injected (`options.client`). Construct it with
 * `retry: { maxRetries: 0 }` so the SDK's own retry loop doesn't double up
 * with this adapter's retry loop.
 */
import {
  AuthenticationError,
  InternalServerError,
  RateLimitError,
  type RequestOptions,
  type ScoreCriteria,
  type Question as SdkQuestion,
  type Questions as SdkQuestions,
  type SystemOneRequest,
  type SystemOneResult,
  choice as sdkChoice,
  noul as sdkNoul,
  score as sdkScore,
} from "@typesafe-ai/sdk";
import type { Decision, DecisionResponse } from "../domain/decision.js";
import type { AnswersFor, DecisionPort, State } from "../domain/ports/decision-port.js";
import { type Question, validateQuestion } from "../domain/question.js";

/**
 * The subset of `TypeSafeClient` this adapter depends on. A real
 * `TypeSafeClient` instance satisfies this structurally; tests inject a fake.
 */
export interface DecisionApiClient {
  systemOne<Q extends SdkQuestions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): {
    withResponse(): Promise<{ data: SystemOneResult<Q>; requestId: string | undefined }>;
  };
}

export interface TypeSafeRetryConfig {
  /** Maximum retries after the initial attempt. */
  readonly maxRetries: number;
  /** First backoff delay in milliseconds, doubled per subsequent retry. */
  readonly initialDelayMs: number;
  /** Cap on the backoff delay before jitter is applied. */
  readonly maxDelayMs: number;
  /** Fraction of each backoff delay randomly subtracted, from 0 to 1. */
  readonly jitterRatio: number;
}

const DEFAULT_RETRY: TypeSafeRetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  jitterRatio: 0.25,
};

const DEFAULT_TIMEOUT_MS = 3000;

export interface TypeSafeDecisionAdapterOptions {
  readonly client: DecisionApiClient;
  /** Per-attempt timeout in milliseconds. Default 3000 (NFR-2). */
  readonly timeoutMs?: number;
  /** Retry overrides; omitted fields fall back to the defaults above. */
  readonly retry?: Partial<TypeSafeRetryConfig>;
  /** Injectable for deterministic tests. Default: real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source, in [0, 1). Default: `Math.random`. */
  readonly random?: () => number;
  /** Injectable clock for latency measurement. Default: `Date.now`. */
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 and 5xx (including the non-standard 529 "overloaded") are retryable; nothing else is (NFR-1). */
function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof InternalServerError) {
    return true;
  }
  if (error instanceof AuthenticationError) {
    return false;
  }
  return false;
}

function backoffDelayMs(attempt: number, retry: TypeSafeRetryConfig, random: () => number): number {
  const raw = Math.min(retry.initialDelayMs * 2 ** attempt, retry.maxDelayMs);
  const jitter = raw * retry.jitterRatio * random();
  return raw - jitter;
}

function toSdkQuestion(question: Question): SdkQuestion {
  switch (question.type) {
    case "noul":
      return sdkNoul(question.instructions, question.criteria);
    case "choice":
      return sdkChoice(question.instructions, question.criteria);
    case "score":
      // Domain criteria is `readonly string[]`, validated (>= 2 entries) by
      // validateQuestion; the SDK's ScoreCriteria type wants that fact
      // encoded as a tuple type, which a plain array can't express.
      return sdkScore(question.instructions, question.criteria as unknown as ScoreCriteria);
  }
}

function toDomainDecision(answer: SystemOneResult<SdkQuestions>["answers"][string]): Decision {
  switch (answer.type) {
    case "noul":
      return { type: "noul", noul: answer.noul };
    case "choice":
      return {
        type: "choice",
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities },
      };
    case "score":
      return {
        type: "score",
        score: answer.score,
        confidence: answer.confidence,
        legend: { ...answer.legend } as Record<number, string>,
        probabilities: { ...answer.probabilities } as Record<number, number>,
      };
  }
}

export function createTypeSafeDecisionAdapter(
  options: TypeSafeDecisionAdapterOptions,
): DecisionPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retry: TypeSafeRetryConfig = { ...DEFAULT_RETRY, ...options.retry };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  return {
    async decide<Q extends Record<string, Question>>(
      state: State,
      questions: Q,
    ): Promise<DecisionResponse<AnswersFor<Q>>> {
      for (const question of Object.values(questions)) {
        validateQuestion(question);
      }

      const sdkQuestions: SdkQuestions = {};
      for (const [key, question] of Object.entries(questions)) {
        sdkQuestions[key] = toSdkQuestion(question);
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
        const start = now();
        try {
          const { data, requestId } = await options.client
            .systemOne({ state, questions: sdkQuestions }, { timeout: timeoutMs })
            .withResponse();
          const latencyMs = now() - start;

          const answers: Record<string, Decision> = {};
          for (const [key, answer] of Object.entries(data.answers)) {
            answers[key] = toDomainDecision(answer);
          }

          return {
            requestId: requestId ?? "unknown",
            model: data.model,
            latencyMs,
            usage: {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
            },
            answers: answers as AnswersFor<Q>,
          };
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt === retry.maxRetries) {
            throw error;
          }
          await sleep(backoffDelayMs(attempt, retry, random));
        }
      }

      // Unreachable: the loop above always returns or throws.
      throw lastError;
    },
  };
}
