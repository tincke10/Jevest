import { describe, expect, it, vi } from "vitest";
import { createFakeFindingLabeler } from "../../adapters/labelers/fake-finding-labeler.js";
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type {
  ClaimVerificationVerdict,
  FindingLabelerOutput,
  FixMatchVerdict,
  LabelerFraming,
} from "../../domain/ports/finding-labeler-port.js";
import type { FindingRecord } from "../filter/finding-record.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { combineOracleVerdicts, runOracleLabeler, summarizeOracleRun } from "./oracle-label.js";

const FIX_MATCH_VERDICTS: readonly FixMatchVerdict[] = ["real", "not-this", "unclear"];
const CLAIM_VERDICTS: readonly ClaimVerificationVerdict[] = ["present", "absent", "unclear"];

describe("combineOracleVerdicts", () => {
  it("calls a finding real only when both passes agree it is the fixed defect and the claim holds", () => {
    expect(combineOracleVerdicts("real", "present")).toBe("real");
  });

  it("calls a finding noise only when both passes agree it is not the fix and the claim is false", () => {
    expect(combineOracleVerdicts("not-this", "absent")).toBe("noise");
  });

  it("returns unknown for every other combination: disagreement is not evidence", () => {
    const decisive = new Set(["real::present", "not-this::absent"]);
    for (const a of FIX_MATCH_VERDICTS) {
      for (const b of CLAIM_VERDICTS) {
        if (decisive.has(`${a}::${b}`)) continue;
        expect(combineOracleVerdicts(a, b)).toBe("unknown");
      }
    }
  });

  it("a plausible but unfixed issue (not-this + present) is unknown, not noise", () => {
    expect(combineOracleVerdicts("not-this", "present")).toBe("unknown");
  });

  it("downgrades real to unknown on a benign hunk: nothing was fixed there to match", () => {
    expect(combineOracleVerdicts("real", "present", { hunkIsDefect: false })).toBe("unknown");
  });

  it("still allows noise on a benign hunk: that is where absence judgments do the work", () => {
    expect(combineOracleVerdicts("not-this", "absent", { hunkIsDefect: false })).toBe("noise");
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function finding(id: string, hunkId: string): FindingRecord {
  return {
    id,
    hunkId,
    datasetVersion: 2,
    reviewer: { provider: "claude-cli", model: "claude-opus-5" },
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 2,
    claim: `claim ${id}`,
    rationale: `rationale ${id}`,
    suggestedSeverity: "minor",
    label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 3 },
    needsManualReview: true,
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.1,
    latencyMs: 100,
  };
}

function hunk(id: string, defect = true): HunkRecord {
  return {
    id,
    repo: "colinhacks/zod",
    license: "MIT",
    commit: "abc",
    parent: "def",
    file: "src/a.ts",
    language: "ts",
    hunkHeader: "@@ -1,2 +1,2 @@",
    before: "before code",
    after: "after code",
    diff: "@@ -1,2 +1,2 @@\n-before code\n+after code",
    label: {
      defect,
      category: "logic",
      touchesPublicApi: false,
      touchesSecurity: false,
      source: "commit-heuristic",
    },
    evidence: { commitMessage: "fix: thing", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
  };
}

function answer(
  framing: LabelerFraming,
  verdict: string,
  overrides: Partial<FindingLabelerOutput> = {},
): FindingLabelerOutput {
  return {
    framing,
    verdict,
    confidence: 0.8,
    reason: `because ${verdict}`,
    model: "deepseek-v4-pro",
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 2000,
    ...overrides,
  } as FindingLabelerOutput;
}

describe("runOracleLabeler", () => {
  it("makes two calls per finding and combines them into one oracle label", async () => {
    const labeler = createFakeFindingLabeler((_input, framing) =>
      answer(framing, framing === "fix-match" ? "real" : "present"),
    );
    const run = await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
    });

    expect(run.results).toHaveLength(1);
    const [result] = run.results;
    expect(result?.verdict).toBe("real");
    expect(result?.fixMatch.verdict).toBe("real");
    expect(result?.fixMatch.reason).toBe("because real");
    expect(result?.claimVerification.verdict).toBe("present");
    expect(result?.labelerModel).toBe("deepseek-v4-pro");
    expect(run.totals.requests).toBe(2);
  });

  it("shows the labeler the fix, the commit message and the evidence, and never the existing label", async () => {
    const seen: { before: string; after: string; commitMessage: string; issueTitle?: string }[] =
      [];
    const labeler = createFakeFindingLabeler((input, framing) => {
      seen.push({
        before: input.before,
        after: input.after,
        commitMessage: input.commitMessage,
        ...(input.issueTitle !== undefined ? { issueTitle: input.issueTitle } : {}),
      });
      expect(JSON.stringify(input)).not.toContain("line-overlap");
      return answer(framing, framing === "fix-match" ? "unclear" : "unclear");
    });

    await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
      evidenceByHunkId: new Map([
        ["h1", { hunkId: "h1", issueTitle: "the issue", fetchedAt: "2026-09-22T00:00:00.000Z" }],
      ]),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.after).toBe("after code");
    expect(seen[0]?.commitMessage).toBe("fix: thing");
    expect(seen[0]?.issueTitle).toBe("the issue");
  });

  it("fails before any call when a finding has no hunk", async () => {
    await expect(
      runOracleLabeler({
        labeler: createFakeFindingLabeler(() => answer("fix-match", "real")),
        findings: [finding("f1", "missing")],
        hunksById: new Map(),
      }),
    ).rejects.toThrow(/no hunk found for finding "f1"/);
  });

  it("records a failure and keeps going when one finding's call throws", async () => {
    const labeler = createFakeFindingLabeler((input, framing) => {
      if (input.findingId === "f1") throw new Error("boom");
      return answer(framing, framing === "fix-match" ? "not-this" : "absent");
    });
    const run = await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1"), finding("f2", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
    });

    expect(run.failures).toEqual([{ findingId: "f1", error: "boom" }]);
    expect(run.results.map((r) => r.verdict)).toEqual(["noise"]);
  });

  it("retries a rate limit with backoff and stops the run when retries are exhausted", async () => {
    const sleep = vi.fn(async () => {});
    const labeler = createFakeFindingLabeler(() => {
      throw new ReviewerRateLimitError("deepseek", new Error("429"));
    });
    const run = await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1"), finding("f2", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
      retry: { maxAttempts: 3, backoffMs: 1, sleep },
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(run.stoppedEarly).toBe(true);
    expect(run.stopReason).toContain("f1");
    expect(run.results).toHaveLength(0);
  });

  it("prices both calls per token with the model's own rate table", async () => {
    const labeler = createFakeFindingLabeler((_input, framing) => answer(framing, "unclear"));
    const run = await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
    });
    // 2 calls x (1000 in @ $1.32/MTok + 100 out @ $3.96/MTok)
    expect(run.totals.totalCostUsd).toBeCloseTo(2 * (0.00132 + 0.000396), 8);
    expect(run.results[0]?.costUsd).toBeCloseTo(2 * (0.00132 + 0.000396), 8);
    expect(run.results[0]?.latencyMs).toBe(4000);
  });

  it("reports progress once per finished finding", async () => {
    const progress: number[] = [];
    await runOracleLabeler({
      labeler: createFakeFindingLabeler((_input, framing) => answer(framing, "unclear")),
      findings: [finding("f1", "h1"), finding("f2", "h1")],
      hunksById: new Map([["h1", hunk("h1")]]),
      concurrency: 2,
      onProgress: ({ completed }) => progress.push(completed),
    });
    expect(progress.sort()).toEqual([1, 2]);
  });

  it("downgrades a real verdict on a benign hunk, as the combination rule requires", async () => {
    const labeler = createFakeFindingLabeler((_input, framing) =>
      answer(framing, framing === "fix-match" ? "real" : "present"),
    );
    const run = await runOracleLabeler({
      labeler,
      findings: [finding("f1", "h1")],
      hunksById: new Map([["h1", hunk("h1", false)]]),
    });
    expect(run.results[0]?.verdict).toBe("unknown");
  });
});

describe("summarizeOracleRun", () => {
  it("counts verdicts, the agreement rate and the unknown share", () => {
    const summary = summarizeOracleRun({
      results: [
        { verdict: "real" },
        { verdict: "real" },
        { verdict: "noise" },
        { verdict: "unknown" },
      ].map((r, i) => ({
        findingId: `f${i}`,
        verdict: r.verdict as "real" | "noise" | "unknown",
        labelerModel: "deepseek-v4-pro",
        fixMatch: { verdict: "real" as FixMatchVerdict, confidence: 0.5, reason: "r" },
        claimVerification: {
          verdict: "present" as ClaimVerificationVerdict,
          confidence: 0.5,
          reason: "r",
        },
        costUsd: 0.001,
        latencyMs: 1000,
      })),
      failures: [{ findingId: "f9", error: "boom" }],
      totals: { requests: 8, totalCostUsd: 0.004, wallTimeMs: 5000 },
      stoppedEarly: false,
    });

    expect(summary.counts).toEqual({ real: 2, noise: 1, unknown: 1 });
    expect(summary.labeled).toBe(4);
    expect(summary.failures).toBe(1);
    expect(summary.agreementRate).toBeCloseTo(0.75, 6);
    expect(summary.unknownShare).toBeCloseTo(0.25, 6);
    expect(summary.latencyP50).toBe(1000);
  });

  it("never divides by zero on an empty run", () => {
    const summary = summarizeOracleRun({
      results: [],
      failures: [],
      totals: { requests: 0, totalCostUsd: 0, wallTimeMs: 0 },
      stoppedEarly: false,
    });
    expect(summary.agreementRate).toBe(0);
    expect(summary.unknownShare).toBe(0);
  });
});
