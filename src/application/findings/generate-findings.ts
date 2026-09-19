/**
 * Runs the phase 1a findings generation over a set of hunks against any
 * ReviewerPort (fake, or a real LLM adapter). SPEC §5 Fase 1a step 2: one
 * reviewer call per hunk, labeled by line-overlap against the fix, cost
 * accumulated against a budget. A hunk whose review call throws is recorded
 * as a failure and the run continues (same "keep going, report what
 * couldn't be processed" shape as ../spike/spike-runner.ts).
 */
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type { FindingRecord, ReviewerProvider } from "../../domain/finding.js";
import { computeFixChangedLines, labelFinding } from "../../domain/line-overlap.js";
import type { ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { type ModelPricing, reviewCostUsd } from "./pricing.js";

export interface GenerateFindingsFailure {
  readonly hunkId: string;
  readonly error: string;
}

export interface GenerateFindingsResult {
  readonly records: FindingRecord[];
  readonly failures: GenerateFindingsFailure[];
  /** Hunks the run actually called the reviewer for (successes + failures). */
  readonly hunksAttempted: number;
  /** Hunks never attempted because the budget was already exceeded, or the run stopped early. */
  readonly hunksSkippedByBudget: number;
  readonly totalCostUsd: number;
  /** True if the run stopped before covering every hunk, for a reason other than the budget. */
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

/**
 * Retries the SAME hunk on a rate-limit / usage-limit signal
 * ({@link ReviewerRateLimitError}) up to `maxAttempts` times total, sleeping
 * `backoffMs` between attempts. Any other error propagates immediately (no
 * retry) — only rate limiting is worth waiting out.
 */
export interface RetryOptions {
  /** Total attempts including the first (e.g. 3 = 1 try + 2 retries). Default 1 (no retry). */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** Injectable for deterministic tests. Default: real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GenerateFindingsOptions {
  readonly hunks: readonly HunkRecord[];
  readonly reviewer: ReviewerPort;
  readonly provider: ReviewerProvider;
  readonly pricing: ModelPricing;
  /** Stops the run (before starting a new hunk) once total cost reaches this. */
  readonly budgetUsd: number;
  /** Hunks reviewed in parallel. Default 1 (sequential, original behavior). */
  readonly concurrency?: number;
  readonly retry?: RetryOptions;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateFindings(
  options: GenerateFindingsOptions,
): Promise<GenerateFindingsResult> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  const backoffMs = options.retry?.backoffMs ?? 0;
  const sleep = options.retry?.sleep ?? defaultSleep;

  const records: FindingRecord[] = [];
  const failures: GenerateFindingsFailure[] = [];
  let totalCostUsd = 0;
  let hunksAttempted = 0;
  let stopped = false;
  let stopReason: string | undefined;
  let nextIndex = 0;

  async function reviewWithRetry(hunk: HunkRecord): Promise<ReviewOutput> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await options.reviewer.review({
          hunkId: hunk.id,
          file: hunk.file,
          language: hunk.language,
          hunkHeader: hunk.hunkHeader,
          before: hunk.before,
          diff: hunk.diff,
        });
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

  function recordFindings(hunk: HunkRecord, output: ReviewOutput): void {
    // A reviewer that reports its own nominal cost (claude-cli, billed
    // against a subscription, not per-token API pricing) wins over the
    // token-pricing table — that number IS the provider's own accounting,
    // ours would be a fiction for a subscription-billed call.
    const cost = output.nominalCostUsd ?? reviewCostUsd(output.usage, options.pricing);
    const billing = output.nominalCostUsd !== undefined ? ("subscription" as const) : undefined;
    totalCostUsd += cost;

    const fixChangedLines = computeFixChangedLines(hunk.diff, hunk.hunkHeader);

    output.findings.forEach((finding, index) => {
      const label = labelFinding(finding, fixChangedLines, hunk.label.defect);
      records.push({
        id: `${hunk.id}::${options.provider}::${index}`,
        hunkId: hunk.id,
        datasetVersion: 2,
        reviewer: { provider: options.provider, model: output.model },
        file: hunk.file,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        claim: finding.claim,
        rationale: finding.rationale,
        suggestedSeverity: finding.suggestedSeverity,
        label,
        needsManualReview: true,
        usage: output.usage,
        costUsd: cost,
        latencyMs: output.latencyMs,
        ...(billing !== undefined ? { billing } : {}),
      });
    });
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped || totalCostUsd >= options.budgetUsd || nextIndex >= options.hunks.length) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const hunk = options.hunks[index];
      if (hunk === undefined) {
        return;
      }
      hunksAttempted += 1;

      try {
        const output = await reviewWithRetry(hunk);
        recordFindings(hunk, output);
      } catch (error) {
        if (error instanceof ReviewerRateLimitError) {
          // Persistent rate limiting means every further call will likely
          // fail the same way — stop the whole run instead of burning
          // through the rest of the dataset one failure at a time.
          stopped = true;
          stopReason = `stopped after exhausting retries on a rate limit / usage limit for hunk "${hunk.id}"`;
        }
        failures.push({
          hunkId: hunk.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    records,
    failures,
    hunksAttempted,
    hunksSkippedByBudget: options.hunks.length - hunksAttempted,
    totalCostUsd,
    stoppedEarly: stopped,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
