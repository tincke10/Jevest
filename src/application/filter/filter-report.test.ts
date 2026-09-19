import { describe, expect, it } from "vitest";
import { expectedCalibrationError } from "../../domain/metrics.js";
import { buildFilterReport, renderFilterReportMarkdown } from "./filter-report.js";
import type { FindingFailure, FindingResult } from "./filter-runner.js";

function makeResult(overrides: Partial<FindingResult>): FindingResult {
  return {
    findingId: "x",
    isRealDefectProb: 0,
    severity: 1,
    severityConfidence: 0.5,
    severityProbabilities: { 0: 0.25, 1: 0.25, 2: 0.25, 3: 0.25 },
    isStyleOnlyProb: 0,
    actionableProb: 0,
    requestId: "r",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

// req1={f1,f2,f3} req2={f4,f5,f6}: dedup must not triple/triple-count tokens/latency.
const results: FindingResult[] = [
  makeResult({
    findingId: "f1",
    isRealDefectProb: 0.9,
    severityConfidence: 0.9,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 0 },
  }),
  makeResult({
    findingId: "f2",
    isRealDefectProb: 0.2,
    severityConfidence: 0.6,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 0 },
  }),
  makeResult({
    findingId: "f3",
    isRealDefectProb: 0.1,
    severityConfidence: 0.7,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 0 },
  }),
  makeResult({
    findingId: "f4",
    isRealDefectProb: 0.8,
    severityConfidence: 0.85,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    findingId: "f5",
    isRealDefectProb: 0.3,
    severityConfidence: 0.4,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
  makeResult({
    findingId: "f6",
    isRealDefectProb: 0.6,
    severityConfidence: 0.55,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 0 },
  }),
];

const realByFindingId: Record<string, boolean> = {
  f1: true,
  f2: false,
  f3: false,
  f4: true,
  f5: true,
  f6: false,
};

function runOf(hunkResults: readonly FindingResult[], failures: readonly FindingFailure[] = []) {
  return { results: hunkResults, failures };
}

describe("buildFilterReport", () => {
  it("sweeps thresholds and reports precision/recall/F1/noise-discarded at a threshold", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    // threshold 0.5: kept = f1(.9) f4(.8) f6(.6); actual real = f1,f4,f5
    // tp=2(f1,f4) fp=1(f6) fn=1(f5) tn=2(f2,f3)
    expect(report.bestMetrics.matrix).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
    expect(report.bestMetrics.recall).toBeCloseTo(2 / 3, 10);
    expect(report.bestMetrics.precision).toBeCloseTo(2 / 3, 10);
    expect(report.bestMetrics.noiseDiscardedRate).toBeCloseTo(2 / 3, 10);
    expect(report.bestThreshold).toBe(0.5);
  });

  it("computes ECE by delegating to the domain function", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    const expected = expectedCalibrationError([
      { prob: 0.9, actual: true },
      { prob: 0.2, actual: false },
      { prob: 0.1, actual: false },
      { prob: 0.8, actual: true },
      { prob: 0.3, actual: true },
      { prob: 0.6, actual: false },
    ]);
    expect(report.ece).toBeCloseTo(expected, 10);
  });

  it("computes a confidence summary over severityConfidence", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    const values = [0.9, 0.6, 0.7, 0.85, 0.4, 0.55];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(report.confidence!.mean).toBeCloseTo(mean, 10);
  });

  it("deduplicates tokens and latency by requestId", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    expect(report.tokens.input).toBe(60); // r1(10) + r2(50)
    expect(report.latency.p50).toBeCloseTo(150, 10); // interpolated between 100 and 200
  });

  it("includes per-finding results with ground truth and probability fields", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    const f1 = report.findings.find((f) => f.findingId === "f1")!;
    expect(f1).toEqual({
      findingId: "f1",
      actualReal: true,
      isRealDefectProb: 0.9,
      severityRaw: 1,
      severityConfidence: 0.9,
      isStyleOnlyProb: 0,
      actionableProb: 0,
      requestId: "r1",
      error: null,
    });
  });

  it("includes failed findings with error set and null probability fields", () => {
    const partial = results.filter((r) => r.findingId !== "f6");
    const failures: FindingFailure[] = [{ findingId: "f6", batchIndex: 1, error: "boom" }];
    const report = buildFilterReport(runOf(partial, failures), realByFindingId, {
      thresholds: [0.5],
    });
    const f6 = report.findings.find((f) => f.findingId === "f6")!;
    expect(f6).toEqual({
      findingId: "f6",
      actualReal: false,
      isRealDefectProb: null,
      severityRaw: null,
      severityConfidence: null,
      isStyleOnlyProb: null,
      actionableProb: null,
      requestId: null,
      error: "boom",
    });
  });

  it("computes an H1 verdict from the best-threshold metrics", () => {
    const passing = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      h1Criteria: { minRecall: 0.5, minNoiseDiscardedRate: 0.5 },
    });
    expect(passing.h1.verdict).toBe("PASS");

    const failing = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      h1Criteria: { minRecall: 0.95, minNoiseDiscardedRate: 0.9 },
    });
    expect(failing.h1.verdict).toBe("FAIL");
  });

  it("carries an optional judge baseline slot through unchanged", () => {
    const judge = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      recall: 0.97,
      noiseDiscarded: 0.6,
      costUsd: 1.2,
      latencyP50: 3000,
    };
    const report = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      judge,
    });
    expect(report.judge).toEqual(judge);
  });

  it("omits the judge slot when not provided", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    expect(report.judge).toBeUndefined();
  });

  it("defaults datasetVersion to 1 and accepts an override", () => {
    const withDefault = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    expect(withDefault.datasetVersion).toBe(1);
    const withOverride = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      datasetVersion: 2,
    });
    expect(withOverride.datasetVersion).toBe(2);
  });

  it("uses an injectable clock for generatedAt", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const report = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      now: () => fixed,
    });
    expect(report.generatedAt).toBe(fixed.toISOString());
  });
});

describe("renderFilterReportMarkdown", () => {
  it("includes the sweep summary, H1 verdict, and DECISION line", () => {
    const report = buildFilterReport(runOf(results), realByFindingId, { thresholds: [0.5] });
    const markdown = renderFilterReportMarkdown(report);
    expect(markdown).toMatch(/H1/);
    expect(markdown).toMatch(/recall/i);
    expect(markdown).toMatch(/noise/i);
    expect(markdown).toMatch(/DECISION/);
  });

  it("includes the judge baseline row when present", () => {
    const judge = {
      provider: "openai",
      model: "gpt-5.1",
      recall: 0.9,
      noiseDiscarded: 0.5,
      costUsd: 2,
      latencyP50: 4000,
    };
    const report = buildFilterReport(runOf(results), realByFindingId, {
      thresholds: [0.5],
      judge,
    });
    const markdown = renderFilterReportMarkdown(report);
    expect(markdown).toContain("openai");
    expect(markdown).toContain("gpt-5.1");
  });
});
