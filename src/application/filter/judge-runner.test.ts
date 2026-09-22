import { describe, expect, it } from "vitest";
import { createFakeFindingJudge } from "../../adapters/judges/fake-finding-judge.js";
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
} from "../../domain/ports/finding-judge-port.js";
import { DEEPSEEK_V4_PRO_PRICING } from "../findings/pricing.js";
import type { FindingRecord } from "./finding-record.js";
import { runJudge } from "./judge-runner.js";

function finding(id: string, overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id,
    hunkId: "h1",
    datasetVersion: 2,
    reviewer: { provider: "claude-cli", model: "claude-opus-5" },
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 4,
    claim: `claim ${id}`,
    rationale: `rationale ${id}`,
    suggestedSeverity: "minor",
    label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 1 },
    needsManualReview: true,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0.01,
    latencyMs: 10,
    ...overrides,
  };
}

const HUNK_DIFFS = new Map([["h1", "@@ -1,3 +1,3 @@\n-a\n+b"]]);

function output(prob: number, overrides: Partial<FindingJudgeOutput> = {}): FindingJudgeOutput {
  return {
    judgment: { isRealDefectProb: prob, severity: "major", isStyleOnly: false, actionable: true },
    model: "claude-opus-5",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 1200,
    nominalCostUsd: 0.02,
    ...overrides,
  };
}

describe("runJudge", () => {
  it("builds the judge input from the Jev state only and maps outputs to results", async () => {
    const seen: FindingJudgeInput[] = [];
    const judge = createFakeFindingJudge((input) => {
      seen.push(input);
      return output(0.9);
    });

    const run = await runJudge({ judge, findings: [finding("f1")], hunkDiffsById: HUNK_DIFFS });

    expect(seen).toEqual([
      {
        findingId: "f1",
        hunkDiff: "@@ -1,3 +1,3 @@\n-a\n+b",
        file: "src/a.ts",
        lineStart: 3,
        lineEnd: 4,
        claim: "claim f1",
        rationale: "rationale f1",
      },
    ]);
    expect(run.results).toEqual([
      {
        findingId: "f1",
        isRealDefectProb: 0.9,
        severity: "major",
        isStyleOnly: false,
        actionable: true,
        model: "claude-opus-5",
        latencyMs: 1200,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0.02,
        billing: "subscription",
      },
    ]);
    expect(run.failures).toEqual([]);
    expect(run.totals.requests).toBe(1);
    expect(run.totals.totalCostUsd).toBeCloseTo(0.02);
  });

  it("prices usage with the pricing table when the judge reports no nominal cost", async () => {
    const judge = createFakeFindingJudge(() => {
      const { nominalCostUsd: _drop, ...priced } = output(0.5, {
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      });
      return priced;
    });
    const run = await runJudge({
      judge,
      findings: [finding("f1")],
      hunkDiffsById: HUNK_DIFFS,
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
    });
    expect(run.results[0]?.costUsd).toBe(5);
    expect(run.results[0]?.billing).toBe("api");
  });

  it("prices a per-token judge by its own model when no pricing is given (DeepSeek rates, not Opus)", async () => {
    const judge = createFakeFindingJudge(() => {
      const { nominalCostUsd: _drop, ...priced } = output(0.5, {
        model: "deepseek-v4-pro",
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      });
      return priced;
    });
    const run = await runJudge({ judge, findings: [finding("f1")], hunkDiffsById: HUNK_DIFFS });
    expect(run.results[0]?.model).toBe("deepseek-v4-pro");
    expect(run.results[0]?.costUsd).toBe(DEEPSEEK_V4_PRO_PRICING.inputPerMTok);
    expect(run.results[0]?.billing).toBe("api");
  });

  it("throws when a finding's hunk diff is missing", async () => {
    const judge = createFakeFindingJudge(() => output(0.5));
    await expect(
      runJudge({ judge, findings: [finding("f1", { hunkId: "nope" })], hunkDiffsById: HUNK_DIFFS }),
    ).rejects.toThrow(/nope/);
  });

  it("records a failure and continues when a judgment throws", async () => {
    const judge = createFakeFindingJudge({ f1: new Error("boom"), f2: output(0.3) });
    const run = await runJudge({
      judge,
      findings: [finding("f1"), finding("f2")],
      hunkDiffsById: HUNK_DIFFS,
    });
    expect(run.failures).toEqual([{ findingId: "f1", error: "boom" }]);
    expect(run.results.map((r) => r.findingId)).toEqual(["f2"]);
  });

  it("retries the same finding on a rate limit with the injected sleep, then stops the run when retries are exhausted", async () => {
    let calls = 0;
    const judge = createFakeFindingJudge(() => {
      calls += 1;
      throw new ReviewerRateLimitError("claude-cli", new Error("usage limit"));
    });
    const sleeps: number[] = [];
    const run = await runJudge({
      judge,
      findings: [finding("f1"), finding("f2"), finding("f3")],
      hunkDiffsById: HUNK_DIFFS,
      concurrency: 1,
      retry: { maxAttempts: 3, backoffMs: 50, sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([50, 50]);
    expect(run.failures).toHaveLength(1);
    expect(run.stoppedEarly).toBe(true);
    expect(run.stopReason).toMatch(/rate limit/);
  });

  it("runs findings in parallel up to the concurrency limit and reports progress", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const judge = createFakeFindingJudge(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return output(0.5);
    });
    const progress: number[] = [];
    const run = await runJudge({
      judge,
      findings: [finding("f1"), finding("f2"), finding("f3"), finding("f4")],
      hunkDiffsById: HUNK_DIFFS,
      concurrency: 2,
      onProgress: ({ completed }) => progress.push(completed),
    });
    expect(run.results).toHaveLength(4);
    expect(maxInFlight).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4]);
  });
});
