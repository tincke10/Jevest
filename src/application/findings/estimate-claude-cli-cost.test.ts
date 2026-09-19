import { describe, expect, it } from "vitest";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { estimateClaudeCliCostUsd } from "./estimate-claude-cli-cost.js";

function hunk(id: string, defect: boolean): HunkRecord {
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
      defect,
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

function reviewerWithCosts(costs: readonly number[], wallMsPerCall: number): ReviewerPort {
  let i = 0;
  return {
    async review(_input: ReviewInput): Promise<ReviewOutput> {
      await new Promise((resolve) => setTimeout(resolve, wallMsPerCall));
      const cost = costs[i]!;
      i += 1;
      return {
        findings: [],
        model: "claude-opus-5",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: wallMsPerCall,
        nominalCostUsd: cost,
      };
    },
  };
}

describe("estimateClaudeCliCostUsd", () => {
  it("calls the reviewer sampleSize times and extrapolates the average nominal cost over targetHunks", async () => {
    const hunks = [
      hunk("a", true),
      hunk("b", false),
      hunk("c", true),
      hunk("d", false),
      hunk("e", true),
    ];
    const reviewer = reviewerWithCosts([0.01, 0.02, 0.03], 0);

    const estimate = await estimateClaudeCliCostUsd({
      reviewer,
      hunks,
      sampleSize: 3,
      targetHunks: 100,
      seed: 42,
    });

    expect(estimate.sampleSize).toBe(3);
    expect(estimate.targetHunks).toBe(100);
    expect(estimate.avgNominalCostUsd).toBeCloseTo(0.02, 6);
    expect(estimate.estimatedTotalUsd).toBeCloseTo(2, 6);
  });

  it("samples at most sampleSize hunks even when more are available", async () => {
    const hunks = Array.from({ length: 10 }, (_, i) => hunk(`h${i}`, i % 2 === 0));
    let calls = 0;
    const reviewer: ReviewerPort = {
      async review(): Promise<ReviewOutput> {
        calls += 1;
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
          nominalCostUsd: 0.01,
        };
      },
    };

    await estimateClaudeCliCostUsd({ reviewer, hunks, sampleSize: 3, targetHunks: 10, seed: 1 });
    expect(calls).toBe(3);
  });

  it("estimates serial wall time as avg wall time per call times targetHunks", async () => {
    const hunks = [hunk("a", true), hunk("b", false)];
    const reviewer = reviewerWithCosts([0.01, 0.01], 5);

    const estimate = await estimateClaudeCliCostUsd({
      reviewer,
      hunks,
      sampleSize: 2,
      targetHunks: 10,
      seed: 1,
    });

    expect(estimate.avgWallMs).toBeGreaterThanOrEqual(5);
    expect(estimate.estimatedWallMsSerial).toBeGreaterThanOrEqual(50);
  });

  it("treats a missing nominalCostUsd as 0 rather than throwing", async () => {
    const hunks = [hunk("a", true)];
    const reviewer: ReviewerPort = {
      async review(): Promise<ReviewOutput> {
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

    const estimate = await estimateClaudeCliCostUsd({
      reviewer,
      hunks,
      sampleSize: 1,
      targetHunks: 10,
      seed: 1,
    });
    expect(estimate.avgNominalCostUsd).toBe(0);
  });
});
