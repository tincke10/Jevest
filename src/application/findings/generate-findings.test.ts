import { describe, expect, it, vi } from "vitest";
import { createFakeReviewer } from "../../adapters/reviewers/fake-reviewer.js";
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { generateFindings } from "./generate-findings.js";
import { CLAUDE_OPUS_5_PRICING } from "./pricing.js";

function hunk(overrides: Partial<HunkRecord> & Pick<HunkRecord, "id">): HunkRecord {
  return {
    repo: "owner/repo",
    license: "MIT",
    commit: "abc123",
    parent: "def456",
    file: "src/thing.ts",
    language: "typescript",
    hunkHeader: "@@ -10,3 +10,3 @@",
    before: "line10\nline11\nline12",
    after: "line10\nfixed11\nline12",
    diff: "@@ -10,3 +10,3 @@\n line10\n-line11\n+fixed11\n line12",
    label: {
      defect: true,
      category: "bugfix",
      touchesPublicApi: null,
      touchesSecurity: null,
      source: "commit-heuristic",
    },
    evidence: { commitMessage: "fix: x", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
    ...overrides,
  };
}

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
// 1M input tokens at claude-opus-5 rates = exactly $5.

describe("generateFindings", () => {
  it("labels a finding as real when the hunk is a defect and the finding overlaps the fix", async () => {
    const h = hunk({ id: "h1" });
    const reviewer = createFakeReviewer({
      h1: {
        findings: [
          {
            lineStart: 11,
            lineEnd: 11,
            claim: "bug",
            rationale: "why",
            suggestedSeverity: "major",
          },
        ],
        model: "claude-opus-5",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 50,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: "h1::anthropic::0",
      hunkId: "h1",
      datasetVersion: 2,
      reviewer: { provider: "anthropic", model: "claude-opus-5" },
      lineStart: 11,
      lineEnd: 11,
      label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 1 },
      needsManualReview: true,
      latencyMs: 50,
    });
    expect(result.failures).toEqual([]);
    expect(result.hunksAttempted).toBe(1);
  });

  it("labels a finding as noise when the hunk is benign, even if it overlaps a changed line", async () => {
    const h = hunk({
      id: "h2",
      label: {
        defect: false,
        category: "refactor",
        touchesPublicApi: null,
        touchesSecurity: null,
        source: "commit-heuristic",
      },
    });
    const reviewer = createFakeReviewer({
      h2: {
        findings: [
          {
            lineStart: 11,
            lineEnd: 11,
            claim: "not a bug",
            rationale: "why",
            suggestedSeverity: "nit",
          },
        ],
        model: "claude-opus-5",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 10,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records[0]!.label).toEqual({
      real: false,
      source: "line-overlap",
      overlapLines: 1,
      fixChangedLines: 1,
    });
  });

  it("produces no records for a hunk with zero findings, but still counts and costs it", async () => {
    const h = hunk({ id: "h3" });
    const reviewer = createFakeReviewer({
      h3: {
        findings: [],
        model: "claude-opus-5",
        usage: USAGE,
        latencyMs: 5,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records).toEqual([]);
    expect(result.hunksAttempted).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(5, 6);
  });

  it("assigns sequential ids for multiple findings from the same hunk", async () => {
    const h = hunk({
      id: "h4",
      hunkHeader: "@@ -1,4 +1,4 @@",
      diff: "@@ -1,4 +1,4 @@\n-a\n-b\n+a2\n+b2",
    });
    const reviewer = createFakeReviewer({
      h4: {
        findings: [
          { lineStart: 1, lineEnd: 1, claim: "c1", rationale: "r1", suggestedSeverity: "nit" },
          { lineStart: 2, lineEnd: 2, claim: "c2", rationale: "r2", suggestedSeverity: "minor" },
        ],
        model: "claude-opus-5",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 1,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "openai",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records.map((r) => r.id)).toEqual(["h4::openai::0", "h4::openai::1"]);
  });

  it("stops before starting a hunk once the budget is exceeded, and reports the count", async () => {
    const h1 = hunk({ id: "h5" });
    const h2 = hunk({ id: "h6" });
    const reviewer = createFakeReviewer({
      h5: { findings: [], model: "claude-opus-5", usage: USAGE, latencyMs: 1 }, // costs $5
      h6: { findings: [], model: "claude-opus-5", usage: USAGE, latencyMs: 1 },
    });

    const result = await generateFindings({
      hunks: [h1, h2],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 5,
    });

    expect(result.hunksAttempted).toBe(1);
    expect(result.hunksSkippedByBudget).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(5, 6);
  });

  it("uses nominalCostUsd as costUsd and marks billing: subscription when the reviewer reports it (claude-cli)", async () => {
    const h = hunk({ id: "h9" });
    const reviewer = createFakeReviewer({
      h9: {
        findings: [
          {
            lineStart: 11,
            lineEnd: 11,
            claim: "bug",
            rationale: "why",
            suggestedSeverity: "major",
          },
        ],
        model: "claude-opus-5",
        usage: {
          inputTokens: 1_000_000, // would be $5 by token pricing
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 50,
        nominalCostUsd: 0.013,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records[0]!.costUsd).toBeCloseTo(0.013, 6);
    expect(result.records[0]!.billing).toBe("subscription");
    expect(result.totalCostUsd).toBeCloseTo(0.013, 6);
  });

  it("leaves billing undefined and costs by token pricing when the reviewer reports no nominalCostUsd", async () => {
    const h = hunk({ id: "h10" });
    const reviewer = createFakeReviewer({
      h10: {
        findings: [
          {
            lineStart: 11,
            lineEnd: 11,
            claim: "bug",
            rationale: "why",
            suggestedSeverity: "major",
          },
        ],
        model: "claude-opus-5",
        usage: USAGE, // 1M input tokens = $5 by token pricing
        latencyMs: 50,
      },
    });

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.records[0]!.costUsd).toBeCloseTo(5, 6);
    expect(result.records[0]!.billing).toBeUndefined();
  });

  it("records a failure and continues past a hunk whose reviewer call throws", async () => {
    const h1 = hunk({ id: "h7" });
    const h2 = hunk({ id: "h8" });
    const reviewer = createFakeReviewer({
      h7: new Error("simulated API failure"),
      h8: { findings: [], model: "claude-opus-5", usage: USAGE, latencyMs: 1 },
    });

    const result = await generateFindings({
      hunks: [h1, h2],
      reviewer,
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });

    expect(result.failures).toEqual([{ hunkId: "h7", error: "simulated API failure" }]);
    expect(result.hunksAttempted).toBe(2);
    expect(result.records).toEqual([]);
    expect(result.totalCostUsd).toBeCloseTo(5, 6);
  });

  it("processes hunks concurrently up to the configured concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const reviewer: ReviewerPort = {
      async review(input: ReviewInput): Promise<ReviewOutput> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return {
          findings: [],
          model: "claude-opus-5",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          latencyMs: 10,
        };
      },
    };
    const hunks = [hunk({ id: "c1" }), hunk({ id: "c2" }), hunk({ id: "c3" }), hunk({ id: "c4" })];

    await generateFindings({
      hunks,
      reviewer,
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
      concurrency: 3,
    });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("retries a rate-limited hunk up to maxAttempts, succeeding once the reviewer recovers", async () => {
    const h = hunk({ id: "r1" });
    let calls = 0;
    const reviewer: ReviewerPort = {
      async review(): Promise<ReviewOutput> {
        calls += 1;
        if (calls < 3) {
          throw new ReviewerRateLimitError("claude-cli", undefined);
        }
        return {
          findings: [],
          model: "claude-opus-5",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          latencyMs: 1,
        };
      },
    };
    const sleep = vi.fn(async () => {});

    const result = await generateFindings({
      hunks: [h],
      reviewer,
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
      retry: { maxAttempts: 3, backoffMs: 60_000, sleep },
    });

    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(result.failures).toEqual([]);
    expect(result.stoppedEarly).toBe(false);
  });

  it("stops the entire run after exhausting retries on a persistent rate limit, never attempting later hunks", async () => {
    const h1 = hunk({ id: "r2" });
    const h2 = hunk({ id: "r3" });
    const reviewer: ReviewerPort = {
      async review(): Promise<ReviewOutput> {
        throw new ReviewerRateLimitError("claude-cli", undefined);
      },
    };
    const sleep = vi.fn(async () => {});

    const result = await generateFindings({
      hunks: [h1, h2],
      reviewer,
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
      concurrency: 1,
      retry: { maxAttempts: 3, backoffMs: 60_000, sleep },
    });

    expect(result.hunksAttempted).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toMatch(/rate.?limit/i);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.hunkId).toBe("r2");
  });
});

describe("generateFindings promptMode", () => {
  function reviewerWithOneFinding(): ReviewerPort {
    return createFakeReviewer({
      h1: {
        findings: [
          { lineStart: 11, lineEnd: 11, claim: "c", rationale: "r", suggestedSeverity: "minor" },
        ],
        model: "claude-opus-5",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 1,
      },
    });
  }

  it("stamps reviewer.promptMode on every record when given", async () => {
    const result = await generateFindings({
      hunks: [hunk({ id: "h1" })],
      reviewer: reviewerWithOneFinding(),
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
      promptMode: "thorough",
    });
    expect(result.records[0]?.reviewer).toEqual({
      provider: "claude-cli",
      model: "claude-opus-5",
      promptMode: "thorough",
    });
  });

  it("leaves reviewer.promptMode absent when not given (strict, unchanged wire shape)", async () => {
    const result = await generateFindings({
      hunks: [hunk({ id: "h1" })],
      reviewer: reviewerWithOneFinding(),
      provider: "claude-cli",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 10,
    });
    expect(result.records[0]?.reviewer).toEqual({ provider: "claude-cli", model: "claude-opus-5" });
  });
});

describe("generateFindings orientation", () => {
  function capturingReviewer(seen: ReviewInput[]): ReviewerPort {
    return {
      async review(input: ReviewInput): Promise<ReviewOutput> {
        seen.push(input);
        return { findings: [], model: "m", usage: USAGE, latencyMs: 1 };
      },
    };
  }

  it("shows the reviewer the recorded before and header for an original hunk", async () => {
    const seen: ReviewInput[] = [];
    await generateFindings({
      hunks: [hunk({ id: "h1" })],
      reviewer: capturingReviewer(seen),
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 100,
    });
    expect(seen[0]?.before).toBe("line10\nline11\nline12");
    expect(seen[0]?.hunkHeader).toBe("@@ -10,3 +10,3 @@");
  });

  it("shows the reviewer the FIXED code and the reversed header for a reversed hunk", async () => {
    const seen: ReviewInput[] = [];
    await generateFindings({
      hunks: [
        hunk({
          id: "h1-rev",
          orientation: "reversed",
          reversedFrom: "h1",
          diff: "@@ -10,4 +10,3 @@\n line10\n-fixed11\n+line11\n line12",
        }),
      ],
      reviewer: capturingReviewer(seen),
      provider: "anthropic",
      pricing: CLAUDE_OPUS_5_PRICING,
      budgetUsd: 100,
    });
    // `after` is the fixed code: on a reversed record the change runs
    // fixed -> buggy, so that is what sits before the change.
    expect(seen[0]?.before).toBe("line10\nfixed11\nline12");
    expect(seen[0]?.hunkHeader).toBe("@@ -10,4 +10,3 @@");
    expect(seen[0]?.diff).toBe("@@ -10,4 +10,3 @@\n line10\n-fixed11\n+line11\n line12");
  });
});
