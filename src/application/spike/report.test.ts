import { describe, expect, it } from "vitest";
import { expectedCalibrationError } from "../../domain/metrics.js";
import type { HunkRecordLabel } from "./hunk-record.js";
import { buildSpikeReport, renderSpikeReportMarkdown } from "./report.js";
import type { HunkResult } from "./spike-runner.js";

// Hand-computed fixture: 6 hunks, 3 defects (h1,h2,h3) and 3 benign (h4,h5,h6),
// grouped into 3 batches of 2 (r1={h1,h2}, r2={h3,h4}, r3={h5,h6}) so token
// and latency totals must be deduplicated by requestId, not summed per hunk.
function makeResult(overrides: Partial<HunkResult>): HunkResult {
  return {
    hunkId: "x",
    serializer: "test-serializer",
    defectScore: 0,
    defectProbabilities: { 0: 1, 1: 0, 2: 0, 3: 0 },
    defectConfidence: 0.5,
    touchesPublicApi: 0,
    touchesSecurity: 0,
    requestId: "r",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

const results: HunkResult[] = [
  makeResult({
    hunkId: "h1",
    defectScore: 3,
    touchesPublicApi: 0.9,
    touchesSecurity: 0.1,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h2",
    defectScore: 2,
    touchesPublicApi: 0.2,
    touchesSecurity: 0.05,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h3",
    defectScore: 0.5,
    touchesPublicApi: 0.5,
    touchesSecurity: 0.5,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h4",
    defectScore: 0,
    touchesPublicApi: 0.1,
    touchesSecurity: 0.05,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h5",
    defectScore: 1,
    touchesPublicApi: 0.3,
    touchesSecurity: 0.2,
    requestId: "r3",
    latencyMs: 300,
    usage: { inputTokens: 80, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h6",
    defectScore: 3,
    touchesPublicApi: 0.95,
    touchesSecurity: 0.9,
    requestId: "r3",
    latencyMs: 300,
    usage: { inputTokens: 80, outputTokens: 0 },
  }),
];

function label(overrides: Partial<HunkRecordLabel>): HunkRecordLabel {
  return {
    defect: false,
    category: "bugfix",
    touchesPublicApi: null,
    touchesSecurity: null,
    source: "commit-heuristic",
    ...overrides,
  };
}

const labelsByHunkId: Record<string, HunkRecordLabel> = {
  h1: label({ defect: true, touchesPublicApi: true, touchesSecurity: false }),
  h2: label({ defect: true, touchesPublicApi: null, touchesSecurity: false }),
  h3: label({ defect: true, touchesPublicApi: false, touchesSecurity: null }),
  h4: label({ defect: false, touchesPublicApi: null, touchesSecurity: false }),
  h5: label({ defect: false, touchesPublicApi: true, touchesSecurity: null }),
  h6: label({ defect: false, touchesPublicApi: false, touchesSecurity: true }),
};

describe("buildSpikeReport", () => {
  it("normalizes defectScore to [0,1] as score/(levels-1) and sweeps the given thresholds", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const [serializerReport] = report.serializers;
    expect(serializerReport!.sweep.map((s) => s.threshold)).toEqual([0, 1 / 3, 2 / 3, 1]);

    // threshold 2/3: predicted positive for h1(1.0), h2(0.667), h6(1.0) -> tp=2 (h1,h2), fp=1 (h6), fn=1 (h3), tn=2 (h4,h5)
    const at23 = serializerReport!.sweep.find((s) => Math.abs(s.threshold - 2 / 3) < 1e-9)!;
    expect(at23.matrix).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
  });

  it("picks the best-F1 threshold, breaking ties toward the lowest threshold", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const [serializerReport] = report.serializers;
    // F1 at threshold 0 and 2/3 tie at 2/3 ≈ 0.667; threshold 0 comes first.
    expect(serializerReport!.bestThreshold).toBe(0);
    expect(serializerReport!.bestMetrics.precision).toBeCloseTo(0.5, 10);
    expect(serializerReport!.bestMetrics.recall).toBeCloseTo(1, 10);
  });

  it("computes H0 verdict from the best-threshold metrics against the given criteria", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
      h0Criteria: { minRecall: 0.85, minF1: 0.75 },
    });
    const [serializerReport] = report.serializers;
    // recall=1 passes, f1≈0.667 fails minF1=0.75
    expect(serializerReport!.h0.verdict).toBe("FAIL");
    expect(serializerReport!.h0.reasons.some((r) => /f1/i.test(r))).toBe(true);
  });

  it("computes ECE for both nouls, filtering out hunks with a null label", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId);
    const [serializerReport] = report.serializers;

    const expectedApiEce = expectedCalibrationError([
      { prob: 0.9, actual: true }, // h1
      { prob: 0.5, actual: false }, // h3
      { prob: 0.3, actual: true }, // h5
      { prob: 0.95, actual: false }, // h6
    ]);
    const expectedSecEce = expectedCalibrationError([
      { prob: 0.1, actual: false }, // h1
      { prob: 0.05, actual: false }, // h2
      { prob: 0.05, actual: false }, // h4
      { prob: 0.9, actual: true }, // h6
    ]);

    expect(serializerReport!.ece.touchesPublicApi).toBeCloseTo(expectedApiEce, 10);
    expect(serializerReport!.ece.touchesSecurity).toBeCloseTo(expectedSecEce, 10);
  });

  it("deduplicates latency and token totals by requestId (batched hunks share one request)", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId);
    const [serializerReport] = report.serializers;

    // 3 unique requests: r1(100ms,100tok) r2(200ms,50tok) r3(300ms,80tok)
    expect(serializerReport!.tokens.input).toBe(230);
    expect(serializerReport!.latency.p50).toBeCloseTo(200, 10);
  });

  it("estimates cost at $0.042 per million input tokens by default", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId);
    const [serializerReport] = report.serializers;
    expect(serializerReport!.estimatedCostUsd).toBeCloseTo((230 / 1_000_000) * 0.042, 12);
  });

  it("marks overallVerdict PASS when at least one serializer passes H0", () => {
    // A second serializer with perfect scores: defect hunks score 3, benign score 0.
    const perfectResults: HunkResult[] = [
      makeResult({
        hunkId: "h1",
        serializer: "perfect",
        defectScore: 3,
        requestId: "p1",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      makeResult({
        hunkId: "h2",
        serializer: "perfect",
        defectScore: 3,
        requestId: "p1",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      makeResult({
        hunkId: "h3",
        serializer: "perfect",
        defectScore: 3,
        requestId: "p2",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      makeResult({
        hunkId: "h4",
        serializer: "perfect",
        defectScore: 0,
        requestId: "p2",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      makeResult({
        hunkId: "h5",
        serializer: "perfect",
        defectScore: 0,
        requestId: "p3",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      makeResult({
        hunkId: "h6",
        serializer: "perfect",
        defectScore: 0,
        requestId: "p3",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    ];
    const report = buildSpikeReport(
      { "test-serializer": results, perfect: perfectResults },
      labelsByHunkId,
      { thresholds: [0, 1 / 3, 2 / 3, 1] },
    );
    expect(report.overallVerdict).toBe("PASS");
  });

  it("marks overallVerdict FAIL when no serializer passes H0", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    expect(report.overallVerdict).toBe("FAIL");
  });

  it("uses an injectable clock for generatedAt", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      now: () => fixed,
    });
    expect(report.generatedAt).toBe(fixed.toISOString());
  });
});

describe("renderSpikeReportMarkdown", () => {
  it("includes a comparison table and a DECISION: continue line when overallVerdict is PASS", () => {
    const report = buildSpikeReport(
      {
        "test-serializer": results,
        perfect: [
          makeResult({ hunkId: "h1", serializer: "perfect", defectScore: 3, requestId: "p1" }),
          makeResult({ hunkId: "h4", serializer: "perfect", defectScore: 0, requestId: "p1" }),
        ],
      },
      labelsByHunkId,
      { thresholds: [0, 1] },
    );
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toContain("test-serializer");
    expect(markdown).toContain("perfect");
    expect(markdown).toMatch(/DECISION: continue/);
  });

  it("prints a DECISION: pivot line when overallVerdict is FAIL", () => {
    const report = buildSpikeReport({ "test-serializer": results }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toMatch(/DECISION: pivot/);
  });
});
