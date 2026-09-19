import { describe, expect, it, vi } from "vitest";
import type { HunkRecord } from "../spike/hunk-record.js";
import { estimateReviewCostUsd } from "./estimate-cost.js";
import { CLAUDE_OPUS_5_PRICING } from "./pricing.js";

function hunk(id: string): HunkRecord {
  return {
    id,
    repo: "owner/repo",
    license: "MIT",
    commit: "c",
    parent: "p",
    file: "src/a.ts",
    language: "typescript",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "const a = 1;",
    after: "const a = 2;",
    diff: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
    label: {
      defect: true,
      category: "bugfix",
      touchesPublicApi: null,
      touchesSecurity: null,
      source: "s",
    },
    evidence: { commitMessage: "fix", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
  };
}

describe("estimateReviewCostUsd", () => {
  it("counts tokens for up to sampleSize hunks and extrapolates over targetHunks", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 1000 }));
    const client = { messages: { countTokens } };
    const hunks = [hunk("a"), hunk("b"), hunk("c"), hunk("d"), hunk("e")];

    const estimate = await estimateReviewCostUsd({
      client,
      hunks,
      sampleSize: 3,
      targetHunks: 100,
      pricing: CLAUDE_OPUS_5_PRICING,
      assumedOutputTokensPerHunk: 0,
    });

    expect(countTokens).toHaveBeenCalledTimes(3);
    expect(estimate.avgInputTokensPerHunk).toBe(1000);
    expect(estimate.sampleSize).toBe(3);
    expect(estimate.targetHunks).toBe(100);
    // 1000 tokens/hunk * 100 hunks = 100,000 tokens = 0.1 MTok * $5/MTok = $0.50
    expect(estimate.estimatedTotalUsd).toBeCloseTo(0.5, 6);
  });

  it("includes an assumed output-token cost when provided", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 0 }));
    const client = { messages: { countTokens } };

    const estimate = await estimateReviewCostUsd({
      client,
      hunks: [hunk("a")],
      sampleSize: 1,
      targetHunks: 100,
      pricing: CLAUDE_OPUS_5_PRICING,
      assumedOutputTokensPerHunk: 200,
    });

    // 200 output tokens/hunk * 100 hunks = 20,000 tokens = 0.02 MTok * $25/MTok = $0.50
    expect(estimate.estimatedTotalUsd).toBeCloseTo(0.5, 6);
  });

  it("samples at most sampleSize hunks even when more are available", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 500 }));
    const client = { messages: { countTokens } };
    const hunks = [hunk("a"), hunk("b"), hunk("c"), hunk("d")];

    await estimateReviewCostUsd({
      client,
      hunks,
      sampleSize: 2,
      targetHunks: 10,
      pricing: CLAUDE_OPUS_5_PRICING,
      assumedOutputTokensPerHunk: 0,
    });

    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it("samples all hunks when there are fewer than sampleSize", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 500 }));
    const client = { messages: { countTokens } };

    const estimate = await estimateReviewCostUsd({
      client,
      hunks: [hunk("a")],
      sampleSize: 3,
      targetHunks: 10,
      pricing: CLAUDE_OPUS_5_PRICING,
      assumedOutputTokensPerHunk: 0,
    });

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(estimate.sampleSize).toBe(1);
  });
});
