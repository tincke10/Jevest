/**
 * Per-run efficiency metrics for SPEC §4.2's two never-measured hypotheses
 * (docs/BENCHMARK.md "H2 / H4 — measured per run"):
 *
 * - H4, "total Jev latency per PR is negligible": every Jev call of the run
 *   (triage, one per profiled hunk, one per classified finding, the merge
 *   gate) contributes its reported `latencyMs`; the sum, nearest-rank p50
 *   and p95, and the max are reported, plus request counts per stage,
 *   tokens and Jev's cost at list price.
 * - H2, "triage + hunk profile cut LLM tokens": the tokens actually spent on
 *   the LLM (review + change summary) against a COUNTERFACTUAL "tokens
 *   without Jev" = what reviewing every hunk would have cost. The reviewed
 *   hunks contribute their measured usage; every hunk the run did not send
 *   to the reviewer (triage skip, skip-change-kind, secret, budget, spend
 *   cap, reviewer disabled) contributes an ESTIMATE from its diff size:
 *   ceil(chars / 4) input tokens plus the run's mean output tokens per
 *   reviewed hunk (150 when nothing was reviewed). That is a floor, not a
 *   measurement: it ignores the prompt and `before` context a real review
 *   call carries, so the saving is if anything understated. `method` says
 *   so in words wherever the numbers are shown.
 *
 * Pure: no ports, no clock. The pipeline measures wall time itself with its
 * injectable `now` and hands the numbers in. Zeros, never null, when a
 * stage did not run, so the Action outputs are always well-formed.
 */
import type { Usage } from "../../domain/decision.js";
import { jevCostUsd } from "../findings/pricing.js";
import type { FindingFilterStageResult } from "./stages/finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./stages/hunk-profile.js";
import type { MergeGateStageResult } from "./stages/merge-gate.js";
import type { ReviewStageResult } from "./stages/review.js";
import type { TriageStageResult } from "./stages/triage.js";

/** Output tokens assumed per skipped hunk when no hunk was reviewed on this run. */
export const DEFAULT_OUTPUT_TOKENS_PER_HUNK = 150;

export interface JevRequestCounts {
  readonly triage: number;
  readonly hunkProfile: number;
  readonly findingFilter: number;
  readonly mergeGate: number;
  readonly total: number;
}

export interface JevLatency {
  readonly sumMs: number;
  /** Nearest-rank percentiles over every Jev call of the run; equal to the single value when there is one. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface JevMetrics {
  readonly requests: JevRequestCounts;
  readonly latency: JevLatency;
  readonly usage: Usage;
  /** Jev's list-price cost for the run (`jevCostUsd` over input tokens). */
  readonly costUsd: number;
}

/** Why a hunk was never sent to the LLM reviewer. Sums to `total`. */
export interface LlmSkippedHunks {
  /** FR-2.3: triage skipped the whole review; the hunks were never profiled. */
  readonly triageSkip: number;
  /** FR-3.3: `change_kind` in `skipChangeKinds` at auto-band confidence (rename-or-format by default). */
  readonly skipChangeKind: number;
  /** NFR-3: the hunk carries a secret. */
  readonly secret: number;
  /** FR-4.3: the per-run `budgetUsd` was exhausted before this hunk. */
  readonly budget: number;
  /** NFR-10: the cumulative spend cap was reached before the run. */
  readonly spendCap: number;
  /** `reviewer.provider: none` (Jev-only mode). */
  readonly reviewerDisabled: number;
  readonly total: number;
}

export interface LlmHunkCounts {
  /** Hunks the run saw: the profiled ones, or the ones split from the PR on a triage skip. */
  readonly total: number;
  /** Not skipped by the hunk profile and no secret: what the review stage would iterate. */
  readonly eligible: number;
  /** Reviewer calls attempted (a reviewer error still counts as attempted). */
  readonly reviewed: number;
  readonly skipped: LlmSkippedHunks;
  /** Hunks beyond `maxHunks`, never profiled; outside the counterfactual because their diff is not kept. */
  readonly truncatedByMaxHunks: number;
}

export interface LlmTokens {
  /** Every input-side token of the review calls: uncached + cache read + cache write. */
  readonly reviewInput: number;
  readonly reviewOutput: number;
  /** The change summary (H7), same input accounting. */
  readonly summaryInput: number;
  readonly summaryOutput: number;
  readonly spent: number;
}

export interface LlmMetrics {
  readonly hunks: LlmHunkCounts;
  readonly tokens: LlmTokens;
  /** Measured review tokens + the estimate for every skipped hunk (see module doc). */
  readonly tokensWithoutJev: number;
  /** `(tokensWithoutJev - tokens.spent) / tokensWithoutJev`, in percent, one decimal; may be negative. 0 when nothing to compare. */
  readonly tokensSavedPct: number;
  /** How the counterfactual was computed, in words, for the summary comment and reports. */
  readonly method: string;
}

export interface StageWallTimes {
  readonly triageMs: number;
  readonly hunkProfileMs: number;
  readonly reviewMs: number;
  readonly findingFilterMs: number;
  readonly mergeGateMs: number;
  readonly publishMs: number;
  /** From the PR fetch to the end of publish (includes the spend ledger round trips). */
  readonly totalMs: number;
}

export interface RunMetrics {
  readonly jev: JevMetrics;
  readonly llm: LlmMetrics;
  readonly wallTime: StageWallTimes;
}

export interface RunMetricsInput {
  readonly triage: TriageStageResult | null;
  readonly hunkProfile: HunkProfileStageResult | null;
  readonly review: ReviewStageResult | null;
  readonly findingFilter: FindingFilterStageResult | null;
  readonly mergeGate: MergeGateStageResult | null;
  /** Diffs of the hunks a triage skip (FR-2.3) kept from ever being profiled; empty otherwise. */
  readonly unprofiledHunkDiffs: readonly string[];
  readonly reviewSkippedForSpendCap: boolean;
  readonly reviewDisabled: boolean;
  readonly wallTime: StageWallTimes;
}

export const ZERO_WALL_TIMES: StageWallTimes = {
  triageMs: 0,
  hunkProfileMs: 0,
  reviewMs: 0,
  findingFilterMs: 0,
  mergeGateMs: 0,
  publishMs: 0,
  totalMs: 0,
};

/** Estimated tokens one review call for `diff` would cost: ceil(chars / 4) input + `outputTokens`. */
export function estimateHunkReviewTokens(diff: string, outputTokens: number): number {
  return Math.ceil(diff.length / 4) + outputTokens;
}

/** Nearest-rank percentile: the ceil(p/100 · n)-th smallest value; 0 for an empty list. */
function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[rank - 1] ?? 0;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

function computeJev(input: RunMetricsInput): JevMetrics {
  const { triage, hunkProfile, findingFilter, mergeGate } = input;
  const latencies: number[] = [];
  let usage = NO_USAGE;

  if (triage) {
    latencies.push(triage.latencyMs);
    usage = addUsage(usage, triage.usage);
  }
  const profiled = hunkProfile?.hunks.filter((h) => h.requestId !== null) ?? [];
  for (const hunk of profiled) latencies.push(hunk.latencyMs);
  if (hunkProfile) usage = addUsage(usage, hunkProfile.totalUsage);
  if (findingFilter) {
    latencies.push(...findingFilter.requestLatenciesMs);
    usage = addUsage(usage, findingFilter.totalUsage);
  }
  if (mergeGate) {
    latencies.push(mergeGate.latencyMs);
    usage = addUsage(usage, mergeGate.usage);
  }

  const requests: JevRequestCounts = {
    triage: triage ? 1 : 0,
    hunkProfile: profiled.length,
    findingFilter: findingFilter?.requestLatenciesMs.length ?? 0,
    mergeGate: mergeGate ? 1 : 0,
    total: 0,
  };
  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    requests: {
      ...requests,
      total: requests.triage + requests.hunkProfile + requests.findingFilter + requests.mergeGate,
    },
    latency: {
      sumMs: latencies.reduce((acc, ms) => acc + ms, 0),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted[sorted.length - 1] ?? 0,
    },
    usage,
    costUsd: jevCostUsd(usage.inputTokens),
  };
}

function isEligible(hunk: HunkProfileEntry): boolean {
  return !hunk.skippedFromReview && !hunk.containsSecret;
}

function computeLlm(input: RunMetricsInput): LlmMetrics {
  const { triage, hunkProfile, review } = input;
  const hunks = hunkProfile?.hunks ?? [];
  const eligible = hunks.filter(isEligible);
  const reviews = review?.reviews ?? [];
  const reviewed = reviews.length;
  // The review stage walks the eligible hunks in order and stops calling the
  // reviewer once the budget is gone, so the unreviewed ones are the tail.
  const unreviewedEligible = eligible.slice(reviewed);
  const secretHunks = hunks.filter((h) => h.containsSecret);
  const changeKindSkipped = hunks.filter((h) => h.skippedFromReview && !h.containsSecret);

  const skipped: LlmSkippedHunks = {
    triageSkip: input.unprofiledHunkDiffs.length,
    skipChangeKind: changeKindSkipped.length,
    secret: secretHunks.length,
    budget: 0,
    spendCap: 0,
    reviewerDisabled: 0,
    total: 0,
  };
  const unreviewedReason: keyof LlmSkippedHunks = input.reviewSkippedForSpendCap
    ? "spendCap"
    : input.reviewDisabled
      ? "reviewerDisabled"
      : "budget";
  const skippedWithReason: LlmSkippedHunks = {
    ...skipped,
    [unreviewedReason]: unreviewedEligible.length,
  };
  const skippedTotal =
    skippedWithReason.triageSkip +
    skippedWithReason.skipChangeKind +
    skippedWithReason.secret +
    skippedWithReason.budget +
    skippedWithReason.spendCap +
    skippedWithReason.reviewerDisabled;

  let reviewInput = 0;
  let reviewOutput = 0;
  let reviewsWithUsage = 0;
  for (const entry of reviews) {
    if (entry.usage === null) continue;
    reviewsWithUsage += 1;
    reviewInput +=
      entry.usage.inputTokens +
      entry.usage.cacheReadInputTokens +
      entry.usage.cacheCreationInputTokens;
    reviewOutput += entry.usage.outputTokens;
  }
  const summary = triage?.summaryUsage ?? null;
  const summaryInput = summary
    ? summary.inputTokens + summary.cacheReadInputTokens + summary.cacheCreationInputTokens
    : 0;
  const summaryOutput = summary?.outputTokens ?? 0;
  const spent = reviewInput + reviewOutput + summaryInput + summaryOutput;

  const outputPerHunk =
    reviewsWithUsage > 0 ? reviewOutput / reviewsWithUsage : DEFAULT_OUTPUT_TOKENS_PER_HUNK;
  const skippedDiffs = [
    ...input.unprofiledHunkDiffs,
    ...changeKindSkipped.map((h) => h.diff),
    ...secretHunks.map((h) => h.diff),
    ...unreviewedEligible.map((h) => h.diff),
  ];
  const estimated = skippedDiffs.reduce(
    (acc, diff) => acc + estimateHunkReviewTokens(diff, outputPerHunk),
    0,
  );
  const tokensWithoutJev = Math.round(reviewInput + reviewOutput + estimated);
  const tokensSavedPct =
    tokensWithoutJev > 0
      ? Math.round(((tokensWithoutJev - spent) / tokensWithoutJev) * 1000) / 10
      : 0;

  const outputWording =
    reviewsWithUsage > 0
      ? `this run's mean output tokens per reviewed hunk (${Math.round(outputPerHunk)})`
      : `${DEFAULT_OUTPUT_TOKENS_PER_HUNK} output tokens (nothing was reviewed on this run)`;

  return {
    hunks: {
      total: hunks.length + input.unprofiledHunkDiffs.length,
      eligible: eligible.length,
      reviewed,
      skipped: { ...skippedWithReason, total: skippedTotal },
      truncatedByMaxHunks: hunkProfile?.truncatedHunkCount ?? 0,
    },
    tokens: { reviewInput, reviewOutput, summaryInput, summaryOutput, spent },
    tokensWithoutJev,
    tokensSavedPct,
    method: `Estimate, not a measurement: tokens without Jev = measured review tokens + for each of the ${skippedDiffs.length} skipped hunk(s) ceil(chars / 4) input tokens + ${outputWording}; the prompt and before-context a real call carries are not counted, so the saving is a floor.`,
  };
}

export function computeRunMetrics(input: RunMetricsInput): RunMetrics {
  return {
    jev: computeJev(input),
    llm: computeLlm(input),
    wallTime: input.wallTime,
  };
}
