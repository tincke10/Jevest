/**
 * The summary pass of the intent–change coherence spike (H7, SPEC §4.2, §5
 * Fase 0c): runs a ChangeSummarizerPort over every PR of the dataset once,
 * producing the `change_summary` layer the "with-summary" variant feeds
 * into the coherence state. It is a separate pass from the Jev run because
 * the summary is per PR (100 calls) while the Jev question is per pair
 * (200 requests), and because the summarizer is the expensive, billed side.
 *
 * The summarizer input is built from `files` only. Title, body and labels
 * never leave this module: a summarizer that saw the author's narrative
 * would echo it and the crossed-description ground truth would be
 * contaminated (see change-summarizer-port.ts for the full argument).
 *
 * Concurrency, rate-limit backoff and the "stop the run on a persistent
 * rate limit" rule mirror findings/generate-findings.ts so a claude-cli
 * usage-limit signal never burns through the whole dataset one 60-second
 * failure at a time.
 */
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type {
  ChangeSummarizerPort,
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import type { PrRecord } from "./pr-record.js";

export interface SummarizeRetryOptions {
  /** Total attempts including the first (e.g. 3 = 1 try + 2 retries). Default 1 (no retry). */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** Injectable for deterministic tests. Default: real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SummarizePrsProgress {
  readonly completed: number;
  readonly total: number;
  readonly prId: string;
}

export interface SummarizePrsOptions {
  readonly records: readonly PrRecord[];
  readonly summarizer: ChangeSummarizerPort;
  /** PRs summarized in parallel. Default 2. */
  readonly concurrency?: number;
  readonly retry?: SummarizeRetryOptions;
  readonly onProgress?: (info: SummarizePrsProgress) => void;
  readonly now?: () => number;
}

export interface SummarizePrsFailure {
  readonly prId: string;
  readonly error: string;
}

export interface SummarizePrsTotals {
  readonly prsAttempted: number;
  /** Successful summarizer calls (failed PRs are not counted). */
  readonly requests: number;
  readonly inputTokens: number;
  /** Cache-read + cache-creation input tokens: where `claude -p` books the actual prompt. */
  readonly cacheInputTokens: number;
  readonly outputTokens: number;
  /** Sum of `nominalCostUsd` over successful calls; 0 when the adapter reports none. */
  readonly nominalCostUsd: number;
  readonly totalLatencyMs: number;
  readonly wallTimeMs: number;
}

export interface SummarizePrsResult {
  readonly summaries: Map<string, ChangeSummaryOutput>;
  readonly failures: SummarizePrsFailure[];
  readonly totals: SummarizePrsTotals;
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

const DEFAULT_CONCURRENCY = 2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Files only: the one place the PR record is narrowed to what the summarizer may see. */
export function toSummaryInput(record: PrRecord): ChangeSummaryInput {
  return {
    prId: record.id,
    files: record.files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
    })),
  };
}

export async function summarizePrs(options: SummarizePrsOptions): Promise<SummarizePrsResult> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  const backoffMs = options.retry?.backoffMs ?? 0;
  const sleep = options.retry?.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const wallStart = now();

  const summaries = new Map<string, ChangeSummaryOutput>();
  const failures: SummarizePrsFailure[] = [];
  let prsAttempted = 0;
  let requests = 0;
  let inputTokens = 0;
  let cacheInputTokens = 0;
  let outputTokens = 0;
  let nominalCostUsd = 0;
  let totalLatencyMs = 0;
  let completed = 0;
  let stopped = false;
  let stopReason: string | undefined;
  let nextIndex = 0;

  async function summarizeWithRetry(record: PrRecord): Promise<ChangeSummaryOutput> {
    const input = toSummaryInput(record);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await options.summarizer.summarize(input);
      } catch (error) {
        if (!(error instanceof ReviewerRateLimitError) || attempt === maxAttempts) {
          throw error;
        }
        await sleep(backoffMs);
      }
    }
    // Unreachable: the loop above always returns or throws.
    throw new Error("unreachable");
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped || nextIndex >= options.records.length) {
        return;
      }
      const record = options.records[nextIndex];
      nextIndex += 1;
      if (record === undefined) {
        return;
      }
      prsAttempted += 1;

      try {
        const output = await summarizeWithRetry(record);
        summaries.set(record.id, output);
        requests += 1;
        inputTokens += output.usage.inputTokens;
        cacheInputTokens +=
          output.usage.cacheReadInputTokens + output.usage.cacheCreationInputTokens;
        outputTokens += output.usage.outputTokens;
        nominalCostUsd += output.nominalCostUsd ?? 0;
        totalLatencyMs += output.latencyMs;
      } catch (error) {
        if (error instanceof ReviewerRateLimitError) {
          // A rate limit that survived every retry will hit the next PR too:
          // stop, let the caller re-run later (recorded fixtures make the
          // re-run skip what is already done).
          stopped = true;
          stopReason = `stopped after exhausting retries on a rate limit / usage limit for pull request "${record.id}"`;
        }
        failures.push({
          prId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completed += 1;
      options.onProgress?.({ completed, total: options.records.length, prId: record.id });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    summaries,
    failures,
    totals: {
      prsAttempted,
      requests,
      inputTokens,
      cacheInputTokens,
      outputTokens,
      nominalCostUsd,
      totalLatencyMs,
      wallTimeMs: now() - wallStart,
    },
    stoppedEarly: stopped,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
