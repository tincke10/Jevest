import { describe, expect, it } from "vitest";
import { jevCostUsd } from "../findings/pricing.js";
import {
  type RunMetricsInput,
  type StageWallTimes,
  computeRunMetrics,
  estimateHunkReviewTokens,
} from "./run-metrics.js";
import type { FindingFilterStageResult } from "./stages/finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./stages/hunk-profile.js";
import type { MergeGateStageResult } from "./stages/merge-gate.js";
import type { ReviewStageEntry, ReviewStageResult } from "./stages/review.js";
import type { TriageStageResult } from "./stages/triage.js";

const ZERO_WALL: StageWallTimes = {
  triageMs: 0,
  hunkProfileMs: 0,
  reviewMs: 0,
  findingFilterMs: 0,
  mergeGateMs: 0,
  publishMs: 0,
  totalMs: 0,
};

function makeTriage(overrides: Partial<TriageStageResult> = {}): TriageStageResult {
  return {
    category: "bugfix",
    categoryConfidence: 0.9,
    riskLevel: "medium",
    jevRiskLevel: "medium",
    riskScore: 2,
    riskConfidence: 0.9,
    needsHumanProb: 0.1,
    containsInjectedInstructionsProb: 0.02,
    matchesIntentProb: 0.9,
    needsProductOwnerProb: 0.1,
    userFacingProb: 0.2,
    breakingProb: 0.05,
    size: "small",
    skipLlmReview: false,
    needsHumanLabel: false,
    needsProductOwnerLabel: false,
    descriptionMismatch: false,
    descriptionMismatchBand: null,
    descriptionMatchesChange: "yes",
    productContext: { productName: null, areas: [], maxCriticality: null, rules: [] },
    changeSummary: null,
    summaryError: null,
    summaryModel: null,
    summaryUsage: null,
    summaryCostUsd: 0,
    requestId: "t1",
    latencyMs: 300,
    usage: { inputTokens: 1000, outputTokens: 50 },
    ...overrides,
  };
}

/** A 40-char diff: ceil(40 / 4) = 10 estimated input tokens. */
const DIFF_40 = "@@ -1,1 +1,1 @@\n-aaaaaaaaaa\n+bbbbbbbbbbb";

function makeHunk(id: string, overrides: Partial<HunkProfileEntry> = {}): HunkProfileEntry {
  return {
    id,
    file: "a.ts",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "old",
    diff: DIFF_40,
    oldStart: 1,
    newStart: 1,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.95,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
    containsReviewerInstructionsProb: 0.02,
    touchesPublicApi: false,
    touchesPublicApiPartial: false,
    astSkipped: null,
    requestId: `hp-${id}`,
    latencyMs: 100,
    usage: { inputTokens: 200, outputTokens: 10 },
    skippedFromReview: false,
    containsSecret: false,
    profileFailed: false,
    ...overrides,
  };
}

function makeHunkProfile(
  hunks: HunkProfileEntry[],
  truncatedHunkCount = 0,
): HunkProfileStageResult {
  const profiled = hunks.filter((h) => h.requestId !== null);
  return {
    hunks,
    injectedInstructionsInDiff: { maxProb: 0.02, hunkIds: [] },
    truncatedHunkCount,
    totalRequests: profiled.length,
    totalLatencyMs: profiled.reduce((acc, h) => acc + h.latencyMs, 0),
    totalUsage: {
      inputTokens: profiled.reduce((acc, h) => acc + h.usage.inputTokens, 0),
      outputTokens: profiled.reduce((acc, h) => acc + h.usage.outputTokens, 0),
    },
  };
}

function makeReviewEntry(
  hunkId: string,
  overrides: Partial<ReviewStageEntry> = {},
): ReviewStageEntry {
  return {
    hunkId,
    file: "a.ts",
    findings: [],
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 900,
      outputTokens: 100,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 50,
    },
    latencyMs: 2000,
    requestId: `rev-${hunkId}`,
    costUsd: 0.01,
    error: null,
    ...overrides,
  };
}

function makeReview(reviews: ReviewStageEntry[], skippedForBudgetCount = 0): ReviewStageResult {
  return {
    reviews,
    totalCostUsd: reviews.reduce((acc, r) => acc + r.costUsd, 0),
    budgetExceeded: skippedForBudgetCount > 0,
    skippedForBudgetCount,
  };
}

function makeFindingFilter(requestLatenciesMs: number[]): FindingFilterStageResult {
  return {
    published: [],
    needsHuman: [],
    discarded: [],
    lowConfidence: [],
    totalRequests: requestLatenciesMs.length,
    totalLatencyMs: requestLatenciesMs.reduce((acc, ms) => acc + ms, 0),
    totalUsage: {
      inputTokens: 40 * requestLatenciesMs.length,
      outputTokens: 4 * requestLatenciesMs.length,
    },
    requestLatenciesMs,
  };
}

function makeMergeGate(overrides: Partial<MergeGateStageResult> = {}): MergeGateStageResult {
  return {
    safeToAutomergeProb: 0.9,
    conclusion: "success",
    requestId: "mg1",
    latencyMs: 250,
    usage: { inputTokens: 60, outputTokens: 5 },
    ...overrides,
  };
}

function makeInput(overrides: Partial<RunMetricsInput> = {}): RunMetricsInput {
  return {
    triage: null,
    hunkProfile: null,
    review: null,
    findingFilter: null,
    mergeGate: null,
    unprofiledHunkDiffs: [],
    reviewSkippedForSpendCap: false,
    reviewDisabled: false,
    wallTime: ZERO_WALL,
    ...overrides,
  };
}

describe("estimateHunkReviewTokens", () => {
  it("prices a skipped hunk at ceil(chars / 4) input tokens plus the given output tokens", () => {
    expect(estimateHunkReviewTokens("abcde", 150)).toBe(2 + 150);
    expect(estimateHunkReviewTokens("", 150)).toBe(150);
  });
});

describe("computeRunMetrics", () => {
  it("returns all zeros when no stage ran (fail-closed at triage)", () => {
    const metrics = computeRunMetrics(makeInput());

    expect(metrics.jev.requests).toEqual({
      triage: 0,
      hunkProfile: 0,
      findingFilter: 0,
      mergeGate: 0,
      total: 0,
    });
    expect(metrics.jev.latency).toEqual({ sumMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    expect(metrics.jev.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(metrics.jev.costUsd).toBe(0);
    expect(metrics.llm.hunks.total).toBe(0);
    expect(metrics.llm.hunks.reviewed).toBe(0);
    expect(metrics.llm.hunks.skipped.total).toBe(0);
    expect(metrics.llm.tokens.spent).toBe(0);
    expect(metrics.llm.tokensWithoutJev).toBe(0);
    expect(metrics.llm.tokensSavedPct).toBe(0);
    expect(metrics.wallTime).toEqual(ZERO_WALL);
  });

  it("counts every Jev request per stage and summarizes their latencies (sum, p50, p95, max) — H4", () => {
    const hunks = [
      makeHunk("a.ts#0", { latencyMs: 100 }),
      makeHunk("a.ts#1", { latencyMs: 400 }),
      // A secret hunk never reaches Jev: no request, no latency.
      makeHunk("a.ts#2", {
        requestId: null,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        skippedFromReview: true,
        containsSecret: true,
      }),
      // A failed profile is not a request either.
      makeHunk("a.ts#3", {
        requestId: null,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        profileFailed: true,
      }),
    ];
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage({ latencyMs: 300 }),
        hunkProfile: makeHunkProfile(hunks),
        review: makeReview([makeReviewEntry("a.ts#0"), makeReviewEntry("a.ts#1")]),
        findingFilter: makeFindingFilter([150, 200]),
        mergeGate: makeMergeGate({ latencyMs: 250 }),
      }),
    );

    // Latencies: 300 (triage), 100, 400 (profile), 150, 200 (filter), 250 (gate).
    expect(metrics.jev.requests).toEqual({
      triage: 1,
      hunkProfile: 2,
      findingFilter: 2,
      mergeGate: 1,
      total: 6,
    });
    expect(metrics.jev.latency.sumMs).toBe(1400);
    expect(metrics.jev.latency.maxMs).toBe(400);
    // Nearest rank over [100,150,200,250,300,400]: p50 -> 3rd = 200, p95 -> 6th = 400.
    expect(metrics.jev.latency.p50Ms).toBe(200);
    expect(metrics.jev.latency.p95Ms).toBe(400);
    expect(metrics.jev.usage).toEqual({
      inputTokens: 1000 + 200 + 200 + 80 + 60,
      outputTokens: 50 + 10 + 10 + 8 + 5,
    });
    expect(metrics.jev.costUsd).toBe(jevCostUsd(1540));
  });

  it("uses nearest-rank percentiles so a single request reports itself as p50, p95 and max", () => {
    const metrics = computeRunMetrics(makeInput({ triage: makeTriage({ latencyMs: 321 }) }));
    expect(metrics.jev.latency).toEqual({ sumMs: 321, p50Ms: 321, p95Ms: 321, maxMs: 321 });
  });

  it("splits hunks into reviewed vs skipped by reason and estimates the H2 counterfactual from the skipped diffs", () => {
    const hunks = [
      makeHunk("a.ts#0"),
      makeHunk("a.ts#1", { changeKind: "rename-or-format", skippedFromReview: true }),
      makeHunk("a.ts#2", {
        requestId: null,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        skippedFromReview: true,
        containsSecret: true,
      }),
      makeHunk("a.ts#3"),
      makeHunk("a.ts#4"),
    ];
    // Eligible: #0, #3, #4. Reviewed: #0 and #3 (mean output 100); #4 skipped for budget.
    const review = makeReview([makeReviewEntry("a.ts#0"), makeReviewEntry("a.ts#3")], 1);
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage({
          summaryUsage: {
            inputTokens: 500,
            outputTokens: 80,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }),
        hunkProfile: makeHunkProfile(hunks, 2),
        review,
        findingFilter: makeFindingFilter([]),
        mergeGate: makeMergeGate(),
      }),
    );

    expect(metrics.llm.hunks).toEqual({
      total: 5,
      eligible: 3,
      reviewed: 2,
      skipped: {
        triageSkip: 0,
        skipChangeKind: 1,
        secret: 1,
        budget: 1,
        spendCap: 0,
        reviewerDisabled: 0,
        total: 3,
      },
      truncatedByMaxHunks: 2,
    });
    // Input tokens count every input-side token (uncached + cache read + cache write).
    expect(metrics.llm.tokens).toEqual({
      reviewInput: 2 * (900 + 50 + 50),
      reviewOutput: 200,
      summaryInput: 500,
      summaryOutput: 80,
      spent: 2000 + 200 + 500 + 80,
    });
    // Counterfactual: actual review tokens (2200) + 3 skipped hunks at ceil(40/4)=10 input + mean output 100 each.
    expect(metrics.llm.tokensWithoutJev).toBe(2200 + 3 * 110);
    // Saved = (2530 - 2780) / 2530: the summary cost more than the three tiny hunks saved -> negative, reported as is.
    expect(metrics.llm.tokensSavedPct).toBeCloseTo(((2530 - 2780) / 2530) * 100, 1);
    expect(metrics.llm.method).toMatch(/ceil\(chars \/ 4\)/);
    expect(metrics.llm.method).toMatch(/mean output tokens/);
  });

  it("falls back to 150 output tokens per skipped hunk when nothing was reviewed (spend cap reached)", () => {
    const hunks = [makeHunk("a.ts#0"), makeHunk("a.ts#1")];
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage(),
        hunkProfile: makeHunkProfile(hunks),
        review: makeReview([]),
        findingFilter: makeFindingFilter([]),
        mergeGate: makeMergeGate(),
        reviewSkippedForSpendCap: true,
      }),
    );

    expect(metrics.llm.hunks.skipped.spendCap).toBe(2);
    expect(metrics.llm.hunks.skipped.budget).toBe(0);
    expect(metrics.llm.tokens.spent).toBe(0);
    expect(metrics.llm.tokensWithoutJev).toBe(2 * (10 + 150));
    expect(metrics.llm.tokensSavedPct).toBe(100);
    expect(metrics.llm.method).toMatch(/150/);
  });

  it("attributes unreviewed eligible hunks to the disabled reviewer in Jev-only mode, never to the budget", () => {
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage(),
        hunkProfile: makeHunkProfile([makeHunk("a.ts#0")]),
        review: makeReview([]),
        findingFilter: makeFindingFilter([]),
        mergeGate: makeMergeGate(),
        reviewDisabled: true,
      }),
    );
    expect(metrics.llm.hunks.skipped.reviewerDisabled).toBe(1);
    expect(metrics.llm.hunks.skipped.budget).toBe(0);
  });

  it("on a triage skip (FR-2.3) counts the unprofiled hunks as saved in full", () => {
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage({ skipLlmReview: true, riskLevel: "low", latencyMs: 280 }),
        unprofiledHunkDiffs: [DIFF_40, DIFF_40, DIFF_40],
      }),
    );

    expect(metrics.jev.requests.total).toBe(1);
    expect(metrics.llm.hunks.total).toBe(3);
    expect(metrics.llm.hunks.eligible).toBe(0);
    expect(metrics.llm.hunks.skipped.triageSkip).toBe(3);
    expect(metrics.llm.hunks.skipped.total).toBe(3);
    expect(metrics.llm.tokensWithoutJev).toBe(3 * 160);
    expect(metrics.llm.tokensSavedPct).toBe(100);
  });

  it("counts a reviewer error as an attempted review with no tokens, and excludes it from the mean output", () => {
    const hunks = [
      makeHunk("a.ts#0"),
      makeHunk("a.ts#1"),
      makeHunk("a.ts#2", { skippedFromReview: true }),
    ];
    const review = makeReview([
      makeReviewEntry("a.ts#0"),
      makeReviewEntry("a.ts#1", {
        model: null,
        usage: null,
        latencyMs: 0,
        requestId: undefined,
        costUsd: 0,
        error: "boom",
      }),
    ]);
    const metrics = computeRunMetrics(
      makeInput({
        triage: makeTriage(),
        hunkProfile: makeHunkProfile(hunks),
        review,
        findingFilter: makeFindingFilter([]),
        mergeGate: makeMergeGate(),
      }),
    );

    expect(metrics.llm.hunks.reviewed).toBe(2);
    expect(metrics.llm.hunks.skipped.total).toBe(1);
    expect(metrics.llm.tokens.reviewInput).toBe(1000);
    expect(metrics.llm.tokens.reviewOutput).toBe(100);
    // One skipped hunk at 10 input + mean output 100 (the errored review does not drag the mean down).
    expect(metrics.llm.tokensWithoutJev).toBe(1100 + 110);
  });

  it("passes the stage wall times through untouched", () => {
    const wallTime: StageWallTimes = {
      triageMs: 10,
      hunkProfileMs: 20,
      reviewMs: 30,
      findingFilterMs: 40,
      mergeGateMs: 50,
      publishMs: 60,
      totalMs: 210,
    };
    expect(computeRunMetrics(makeInput({ wallTime })).wallTime).toEqual(wallTime);
  });
});
