import { describe, expect, it } from "vitest";
import type { FindingRecord } from "../../domain/finding.js";
import { summarizeFindings } from "./summary.js";

function record(overrides: Partial<FindingRecord> & { id: string; hunkId: string }): FindingRecord {
  return {
    datasetVersion: 2,
    reviewer: { provider: "anthropic", model: "claude-opus-5" },
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 1,
    claim: "c",
    rationale: "r",
    suggestedSeverity: "minor",
    label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 1 },
    needsManualReview: true,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    costUsd: 0.01,
    latencyMs: 100,
    ...overrides,
  };
}

describe("summarizeFindings", () => {
  // Hand-computed 5-row dataset (SPEC §10.6 style):
  // hunk1 (defect): 2 findings, both real (overlap), cost $0.01, latency 100ms
  // hunk2 (defect): 1 finding, noise (no overlap), cost $0.02, latency 200ms
  // hunk3 (benign): 1 finding, noise (benign hunk), cost $0.03, latency 300ms
  // hunk4 (benign): 1 finding, noise (benign hunk), cost $0.04, latency 400ms
  // hunk5 (defect): 0 findings (not represented in records), cost/latency untracked here
  const records: FindingRecord[] = [
    record({
      id: "hunk1::anthropic::0",
      hunkId: "hunk1",
      costUsd: 0.01,
      latencyMs: 100,
      suggestedSeverity: "major",
      label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 2 },
    }),
    record({
      id: "hunk1::anthropic::1",
      hunkId: "hunk1",
      costUsd: 0.01,
      latencyMs: 100,
      suggestedSeverity: "minor",
      label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 2 },
    }),
    record({
      id: "hunk2::anthropic::0",
      hunkId: "hunk2",
      costUsd: 0.02,
      latencyMs: 200,
      suggestedSeverity: "nit",
      label: { real: false, source: "line-overlap", overlapLines: 0, fixChangedLines: 1 },
    }),
    record({
      id: "hunk3::anthropic::0",
      hunkId: "hunk3",
      costUsd: 0.03,
      latencyMs: 300,
      suggestedSeverity: "critical",
      label: { real: false, source: "line-overlap", overlapLines: 1, fixChangedLines: 1 },
    }),
    record({
      id: "hunk4::anthropic::0",
      hunkId: "hunk4",
      costUsd: 0.04,
      latencyMs: 400,
      suggestedSeverity: "minor",
      label: { real: false, source: "line-overlap", overlapLines: 0, fixChangedLines: 1 },
    }),
  ];
  const defectByHunkId = new Map([
    ["hunk1", true],
    ["hunk2", true],
    ["hunk3", false],
    ["hunk4", false],
    ["hunk5", true],
  ]);

  it("counts total findings, real vs noise, and findings per hunk over all hunks reviewed", () => {
    const summary = summarizeFindings({ records, hunksReviewed: 5, defectByHunkId });
    expect(summary.totalFindings).toBe(5);
    expect(summary.realCount).toBe(2);
    expect(summary.noiseCount).toBe(3);
    expect(summary.hunksReviewed).toBe(5);
    expect(summary.findingsPerHunk).toBeCloseTo(1, 6); // 5 findings / 5 hunks
  });

  it("counts findings per severity", () => {
    const summary = summarizeFindings({ records, hunksReviewed: 5, defectByHunkId });
    expect(summary.countsBySeverity).toEqual({ nit: 1, minor: 2, major: 1, critical: 1 });
  });

  it("computes the percentage of findings that landed on a benign hunk", () => {
    const summary = summarizeFindings({ records, hunksReviewed: 5, defectByHunkId });
    // hunk3 (1 finding) and hunk4 (1 finding) are benign: 2 of 5 findings = 40%.
    expect(summary.percentFindingsOnBenignHunks).toBeCloseTo(40, 6);
  });

  it("returns 0% on benign hunks when there are no findings", () => {
    const summary = summarizeFindings({ records: [], hunksReviewed: 0, defectByHunkId: new Map() });
    expect(summary.percentFindingsOnBenignHunks).toBe(0);
    expect(summary.findingsPerHunk).toBe(0);
  });

  it("sums cost once per unique hunk (cost is per-request, repeated across a hunk's findings)", () => {
    const summary = summarizeFindings({ records, hunksReviewed: 5, defectByHunkId });
    // hunk1's $0.01 must be counted once, not twice, even though it has 2 finding rows.
    expect(summary.totalCostUsd).toBeCloseTo(0.01 + 0.02 + 0.03 + 0.04, 6);
  });

  it("computes latency percentiles once per unique hunk", () => {
    const summary = summarizeFindings({ records, hunksReviewed: 5, defectByHunkId });
    // Unique per-hunk latencies: [100, 200, 300, 400] (hunk1 counted once).
    expect(summary.latencyMs.p50).toBeGreaterThanOrEqual(200);
    expect(summary.latencyMs.p50).toBeLessThanOrEqual(300);
    expect(summary.latencyMs.p99).toBe(400);
  });

  it("computes cache hit share once per unique hunk (cache_read / (input + cache_read + cache_creation))", () => {
    const cachedRecords: FindingRecord[] = [
      record({
        id: "hunkA::anthropic::0",
        hunkId: "hunkA",
        usage: {
          inputTokens: 0,
          outputTokens: 5,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 0,
        },
      }),
      record({
        id: "hunkA::anthropic::1",
        hunkId: "hunkA",
        usage: {
          inputTokens: 0,
          outputTokens: 5,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 0,
        },
      }),
      record({
        id: "hunkB::anthropic::0",
        hunkId: "hunkB",
        usage: {
          inputTokens: 100,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ];
    const summary = summarizeFindings({
      records: cachedRecords,
      hunksReviewed: 2,
      defectByHunkId: new Map([
        ["hunkA", true],
        ["hunkB", true],
      ]),
    });
    // hunkA counted once: 900 cache-read of 900 total = 1.0; hunkB: 0 of 100 = 0.
    // Weighted across the two unique hunks: 900 / (900 + 100) = 0.9.
    expect(summary.cacheHitShare).toBeCloseTo(0.9, 6);
  });

  it("returns 0 cache hit share when there is no usage at all", () => {
    const summary = summarizeFindings({ records: [], hunksReviewed: 0, defectByHunkId: new Map() });
    expect(summary.cacheHitShare).toBe(0);
  });
});
