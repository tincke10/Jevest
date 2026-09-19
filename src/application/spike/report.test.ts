import { describe, expect, it } from "vitest";
import { expectedCalibrationError } from "../../domain/metrics.js";
import type { HunkRecordLabel } from "./hunk-record.js";
import { buildSpikeReport, renderSpikeReportMarkdown } from "./report.js";
import type { HunkFailure, HunkResult } from "./spike-runner.js";

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
    defectConfidence: 0.9,
    touchesPublicApi: 0.9,
    touchesSecurity: 0.1,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h2",
    defectScore: 2,
    defectConfidence: 0.8,
    touchesPublicApi: 0.2,
    touchesSecurity: 0.05,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h3",
    defectScore: 0.5,
    defectConfidence: 0.4,
    touchesPublicApi: 0.5,
    touchesSecurity: 0.5,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h4",
    defectScore: 0,
    defectConfidence: 0.7,
    touchesPublicApi: 0.1,
    touchesSecurity: 0.05,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h5",
    defectScore: 1,
    defectConfidence: 0.6,
    touchesPublicApi: 0.3,
    touchesSecurity: 0.2,
    requestId: "r3",
    latencyMs: 300,
    usage: { inputTokens: 80, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h6",
    defectScore: 3,
    defectConfidence: 0.95,
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

function runOf(hunkResults: readonly HunkResult[], failures: readonly HunkFailure[] = []) {
  return { results: hunkResults, failures };
}

describe("buildSpikeReport", () => {
  it("normalizes defectScore to [0,1] as score/(levels-1) and sweeps the given thresholds", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const [serializerReport] = report.serializers;
    expect(serializerReport!.sweep.map((s) => s.threshold)).toEqual([0, 1 / 3, 2 / 3, 1]);

    const at23 = serializerReport!.sweep.find((s) => Math.abs(s.threshold - 2 / 3) < 1e-9)!;
    expect(at23.matrix).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
  });

  it("picks the best-F1 threshold, breaking ties toward the lowest threshold", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const [serializerReport] = report.serializers;
    expect(serializerReport!.bestThreshold).toBe(0);
    expect(serializerReport!.bestMetrics.precision).toBeCloseTo(0.5, 10);
    expect(serializerReport!.bestMetrics.recall).toBeCloseTo(1, 10);
  });

  it("computes H0 verdict from the best-threshold metrics against the given criteria", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
      h0Criteria: { minRecall: 0.85, minF1: 0.75 },
    });
    const [serializerReport] = report.serializers;
    expect(serializerReport!.h0.verdict).toBe("FAIL");
    expect(serializerReport!.h0.reasons.some((r) => /f1/i.test(r))).toBe(true);
  });

  it("computes ECE for both nouls, filtering out hunks with a null label", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
    const [serializerReport] = report.serializers;

    const expectedApiEce = expectedCalibrationError([
      { prob: 0.9, actual: true },
      { prob: 0.5, actual: false },
      { prob: 0.3, actual: true },
      { prob: 0.95, actual: false },
    ]);
    const expectedSecEce = expectedCalibrationError([
      { prob: 0.1, actual: false },
      { prob: 0.05, actual: false },
      { prob: 0.05, actual: false },
      { prob: 0.9, actual: true },
    ]);

    expect(serializerReport!.ece.touchesPublicApi).toBeCloseTo(expectedApiEce, 10);
    expect(serializerReport!.ece.touchesSecurity).toBeCloseTo(expectedSecEce, 10);
  });

  it("deduplicates latency and token totals by requestId (batched hunks share one request)", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
    const [serializerReport] = report.serializers;
    expect(serializerReport!.tokens.input).toBe(230);
    expect(serializerReport!.latency.p50).toBeCloseTo(200, 10);
  });

  it("estimates cost at $0.042 per million input tokens by default", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
    const [serializerReport] = report.serializers;
    expect(serializerReport!.estimatedCostUsd).toBeCloseTo((230 / 1_000_000) * 0.042, 12);
  });

  it("marks overallVerdict FAIL when no serializer passes H0", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    expect(report.overallVerdict).toBe("FAIL");
  });

  it("uses an injectable clock for generatedAt", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      now: () => fixed,
    });
    expect(report.generatedAt).toBe(fixed.toISOString());
  });

  it("defaults datasetVersion to 1 and accepts an explicit override", () => {
    const withDefault = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
    expect(withDefault.datasetVersion).toBe(1);

    const withOverride = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      datasetVersion: 2,
    });
    expect(withOverride.datasetVersion).toBe(2);
  });

  describe("per-hunk results", () => {
    it("includes a hunks array with the requested fields for successful hunks", () => {
      const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
      const [serializerReport] = report.serializers;
      const h1 = serializerReport!.hunks.find((h) => h.hunkId === "h1")!;

      expect(h1).toEqual({
        hunkId: "h1",
        actualDefect: true,
        defectScoreRaw: 3,
        defectScoreNormalized: 1,
        defectConfidence: 0.9,
        defectProbabilities: { 0: 1, 1: 0, 2: 0, 3: 0 },
        touchesPublicApi: 0.9,
        touchesPublicApiLabel: true,
        touchesSecurity: 0.1,
        touchesSecurityLabel: false,
        requestId: "r1",
        error: null,
      });
    });

    it("includes failed hunks with error set and decision fields null", () => {
      const partialResults = results.filter((r) => r.hunkId !== "h6");
      const failures: HunkFailure[] = [{ hunkId: "h6", batchIndex: 2, error: "boom" }];
      const report = buildSpikeReport(
        { "test-serializer": runOf(partialResults, failures) },
        labelsByHunkId,
      );
      const [serializerReport] = report.serializers;
      const h6 = serializerReport!.hunks.find((h) => h.hunkId === "h6")!;

      expect(h6).toEqual({
        hunkId: "h6",
        actualDefect: false,
        defectScoreRaw: null,
        defectScoreNormalized: null,
        defectConfidence: null,
        defectProbabilities: null,
        touchesPublicApi: null,
        touchesPublicApiLabel: false,
        touchesSecurity: null,
        touchesSecurityLabel: true,
        requestId: null,
        error: "boom",
      });
    });
  });

  describe("confidence summary", () => {
    it("computes p10/p50/p90/mean of defectConfidence", () => {
      // confidences: h1=.9 h2=.8 h3=.4 h4=.7 h5=.6 h6=.95 -> sorted: .4 .6 .7 .8 .9 .95
      const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
      const [serializerReport] = report.serializers;
      const sorted = [0.4, 0.6, 0.7, 0.8, 0.9, 0.95];
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      expect(serializerReport!.confidence!.mean).toBeCloseTo(mean, 10);
      expect(serializerReport!.confidence!.p50).toBeGreaterThan(0);
    });

    it("is null when a serializer has zero successful hunks", () => {
      const failures: HunkFailure[] = results.map((r) => ({
        hunkId: r.hunkId,
        batchIndex: 0,
        error: "boom",
      }));
      const report = buildSpikeReport({ "test-serializer": runOf([], failures) }, labelsByHunkId);
      const [serializerReport] = report.serializers;
      expect(serializerReport!.confidence).toBeNull();
    });
  });

  describe("agreement", () => {
    it("marks a hunk as agreeing when all serializers predict the same outcome at their own best threshold", () => {
      // Serializer A: threshold 0 -> everyone predicted positive.
      // Serializer B: threshold 1 -> only score===3 (normalized 1) predicted positive.
      const report = buildSpikeReport(
        {
          a: runOf(results),
          b: runOf(results),
        },
        labelsByHunkId,
        { thresholds: [0, 1] }, // both serializers see the same sweep candidates
      );

      // Both serializers here are identical inputs, so predictions always agree.
      expect(report.agreement.totalCount).toBe(6);
      expect(report.agreement.agreedCount).toBe(6);
      for (const entry of report.agreement.hunks) {
        expect(entry.agree).toBe(true);
      }
    });

    it("only considers hunks present with a successful result in every serializer", () => {
      const partial = results.filter((r) => r.hunkId !== "h6");
      const report = buildSpikeReport(
        {
          a: runOf(results),
          b: runOf(partial, [{ hunkId: "h6", batchIndex: 2, error: "boom" }]),
        },
        labelsByHunkId,
        { thresholds: [0, 1] },
      );
      expect(report.agreement.hunks.some((h) => h.hunkId === "h6")).toBe(false);
      expect(report.agreement.totalCount).toBe(5);
    });
  });
});

describe("renderSpikeReportMarkdown", () => {
  it("includes a comparison table and a DECISION: continue line when overallVerdict is PASS", () => {
    const report = buildSpikeReport(
      {
        "test-serializer": runOf(results),
        perfect: runOf([
          makeResult({ hunkId: "h1", serializer: "perfect", defectScore: 3, requestId: "p1" }),
          makeResult({ hunkId: "h4", serializer: "perfect", defectScore: 0, requestId: "p1" }),
        ]),
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
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId, {
      thresholds: [0, 1 / 3, 2 / 3, 1],
    });
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toMatch(/DECISION: pivot/);
  });

  it("includes a Confidence (defect_likelihood) section with percentiles per serializer", () => {
    const report = buildSpikeReport({ "test-serializer": runOf(results) }, labelsByHunkId);
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toContain("Confidence (defect_likelihood)");
    expect(markdown).toContain("test-serializer");
  });

  it("lists consistent misses and consistent false positives across all serializers", () => {
    // threshold=1 for both -> only score===3 predicted positive.
    // actual defects: h1,h2,h3; actual benign: h4,h5,h6.
    // predicted positive (score norm===1): h1, h6. So:
    //  - h2, h3 are actual defect but predicted negative by both -> consistent misses
    //  - h6 is actual benign but predicted positive by both -> consistent false positive
    const report = buildSpikeReport({ a: runOf(results), b: runOf(results) }, labelsByHunkId, {
      thresholds: [1],
    });
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toContain("Consistent misses");
    expect(markdown).toContain("h2");
    expect(markdown).toContain("h3");
    expect(markdown).toContain("h6");
  });

  it("caps consistent misses/false positives lists at 20 entries with a remainder note", () => {
    const manyResults: HunkResult[] = [];
    const manyLabels: Record<string, HunkRecordLabel> = {};
    for (let i = 0; i < 25; i++) {
      const id = `miss-${i}`;
      manyResults.push(
        makeResult({ hunkId: id, defectScore: 0, requestId: `req-${i}`, defectConfidence: 0.5 }),
      );
      manyLabels[id] = label({ defect: true }); // actual defect, but score 0 -> predicted negative at any threshold > 0
    }
    const report = buildSpikeReport({ a: runOf(manyResults), b: runOf(manyResults) }, manyLabels, {
      thresholds: [0.5],
    });
    const markdown = renderSpikeReportMarkdown(report);
    expect(markdown).toMatch(/\+5 more/);
  });
});
