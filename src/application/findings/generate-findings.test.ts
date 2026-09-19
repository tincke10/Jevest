import { describe, expect, it } from "vitest";
import { createFakeReviewer } from "../../adapters/reviewers/fake-reviewer.js";
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
});
