import { describe, expect, it } from "vitest";
import { expectedCalibrationError } from "../../domain/metrics.js";
import type { ProfileLabels } from "./profile-label-record.js";
import { buildProfileReport, renderProfileReportMarkdown } from "./profile-report.js";
import type { ProfileHunkFailure, ProfileHunkResult } from "./profile-runner.js";

// 8 hunks: accuracy = 6/8 = 0.75, with a hand-computable confusion per class.
// actual:    h1=add h2=add h3=mod h4=mod h5=del h6=del h7=ren h8=ren
// predicted: h1=add h2=mod h3=mod h4=mod h5=del h6=add h7=ren h8=ren
function makeResult(overrides: Partial<ProfileHunkResult>): ProfileHunkResult {
  return {
    hunkId: "x",
    serializer: "raw-diff",
    changeKind: "add-behavior",
    changeKindProbabilities: {
      "add-behavior": 1,
      "modify-behavior": 0,
      delete: 0,
      "rename-or-format": 0,
    },
    changeKindConfidence: 0.5,
    touchesPublicApi: 0,
    touchesErrorHandling: 0,
    touchesAsync: 0,
    touchesIo: 0,
    requestId: "r",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function makeLabel(overrides: Partial<ProfileLabels>): ProfileLabels {
  return {
    changeKind: "add-behavior",
    touchesPublicApi: false,
    touchesErrorHandling: false,
    touchesAsync: false,
    touchesIo: false,
    ...overrides,
  };
}

// touches_io: actual true for h1, h3; predicted probs as below.
// touches_public_api/error_handling/async each get exactly one true label
// (on h1/h3/h5 respectively) with a matching high score, so every noul has
// at least one actual positive and a perfect prediction for it — otherwise
// F1 is trivially 0 by convention (no actual positives) and no threshold
// could ever "pass" that noul.
const results: ProfileHunkResult[] = [
  makeResult({
    hunkId: "h1",
    changeKind: "add-behavior",
    changeKindConfidence: 0.9,
    touchesPublicApi: 0.9,
    touchesIo: 0.9,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h2",
    changeKind: "modify-behavior",
    changeKindConfidence: 0.6,
    touchesIo: 0.1,
    requestId: "r1",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h3",
    changeKind: "modify-behavior",
    changeKindConfidence: 0.8,
    touchesErrorHandling: 0.9,
    touchesIo: 0.8,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 20, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h4",
    changeKind: "modify-behavior",
    changeKindConfidence: 0.7,
    touchesIo: 0.2,
    requestId: "r2",
    latencyMs: 200,
    usage: { inputTokens: 20, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h5",
    changeKind: "delete",
    changeKindConfidence: 0.85,
    touchesAsync: 0.9,
    touchesIo: 0.3,
    requestId: "r3",
    latencyMs: 300,
    usage: { inputTokens: 30, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h6",
    changeKind: "add-behavior",
    changeKindConfidence: 0.4,
    touchesIo: 0.1,
    requestId: "r3",
    latencyMs: 300,
    usage: { inputTokens: 30, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h7",
    changeKind: "rename-or-format",
    changeKindConfidence: 0.95,
    touchesIo: 0.05,
    requestId: "r4",
    latencyMs: 400,
    usage: { inputTokens: 40, outputTokens: 0 },
  }),
  makeResult({
    hunkId: "h8",
    changeKind: "rename-or-format",
    changeKindConfidence: 0.99,
    touchesIo: 0.4,
    requestId: "r4",
    latencyMs: 400,
    usage: { inputTokens: 40, outputTokens: 0 },
  }),
];

const labelsByHunkId: Record<string, ProfileLabels> = {
  h1: makeLabel({ changeKind: "add-behavior", touchesPublicApi: true, touchesIo: true }),
  h2: makeLabel({ changeKind: "add-behavior", touchesIo: false }),
  h3: makeLabel({ changeKind: "modify-behavior", touchesErrorHandling: true, touchesIo: true }),
  h4: makeLabel({ changeKind: "modify-behavior", touchesIo: false }),
  h5: makeLabel({ changeKind: "delete", touchesAsync: true, touchesIo: false }),
  h6: makeLabel({ changeKind: "delete", touchesIo: false }),
  h7: makeLabel({ changeKind: "rename-or-format", touchesIo: false }),
  h8: makeLabel({ changeKind: "rename-or-format", touchesIo: false }),
};

function runOf(
  hunkResults: readonly ProfileHunkResult[],
  failures: readonly ProfileHunkFailure[] = [],
) {
  return { results: hunkResults, failures };
}

describe("buildProfileReport", () => {
  it("computes overall choice accuracy", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    expect(s!.changeKind.accuracy).toBeCloseTo(0.75, 10);
  });

  it("computes per-class precision/recall/F1 and support for the choice", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    const addClass = s!.changeKind.perClass.find((c) => c.label === "add-behavior")!;
    expect(addClass.precision).toBeCloseTo(0.5, 10);
    expect(addClass.recall).toBeCloseTo(0.5, 10);
    expect(addClass.f1).toBeCloseTo(0.5, 10);
    expect(addClass.support).toBe(2);

    const modClass = s!.changeKind.perClass.find((c) => c.label === "modify-behavior")!;
    expect(modClass.precision).toBeCloseTo(2 / 3, 10);
    expect(modClass.recall).toBeCloseTo(1, 10);
    expect(modClass.support).toBe(2);

    const renameClass = s!.changeKind.perClass.find((c) => c.label === "rename-or-format")!;
    expect(renameClass.precision).toBe(1);
    expect(renameClass.recall).toBe(1);
    expect(renameClass.f1).toBe(1);
  });

  it("computes a confidence summary over changeKindConfidence", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    const confidences = [0.9, 0.6, 0.8, 0.7, 0.85, 0.4, 0.95, 0.99];
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    expect(s!.changeKindConfidence!.mean).toBeCloseTo(mean, 10);
  });

  it("sweeps each noul and reports precision/recall/F1 at a given threshold", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    const io = s!.nouls.find((n) => n.name === "touches_io")!;
    // threshold 0.5: predicted positive for h1(0.9), h3(0.8) only -> matches actual exactly
    expect(io.bestMetrics.matrix).toEqual({ tp: 2, fp: 0, fn: 0, tn: 6 });
    expect(io.bestMetrics.precision).toBe(1);
    expect(io.bestMetrics.recall).toBe(1);
    expect(io.bestMetrics.f1).toBe(1);
  });

  it("computes ECE per noul by delegating to the domain function", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    const io = s!.nouls.find((n) => n.name === "touches_io")!;
    const expected = expectedCalibrationError([
      { prob: 0.9, actual: true },
      { prob: 0.1, actual: false },
      { prob: 0.8, actual: true },
      { prob: 0.2, actual: false },
      { prob: 0.3, actual: false },
      { prob: 0.1, actual: false },
      { prob: 0.05, actual: false },
      { prob: 0.4, actual: false },
    ]);
    expect(io.ece).toBeCloseTo(expected, 10);
  });

  it("computes all four noul reports", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    expect(s!.nouls.map((n) => n.name).sort()).toEqual(
      ["touches_public_api", "touches_error_handling", "touches_async", "touches_io"].sort(),
    );
  });

  it("deduplicates tokens and latency by requestId", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const [s] = report.serializers;
    // unique requests: r1(10) r2(20) r3(30) r4(40) -> 100
    expect(s!.tokens.input).toBe(100);
  });

  it("computes an H0' verdict from accuracy, noul F1s, and median confidence", () => {
    const passing = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
      h0Criteria: { minAccuracy: 0.5, minNoulF1: 0.5, minMedianConfidence: 0.5 },
    });
    expect(passing.serializers[0]!.h0Prime.verdict).toBe("PASS");

    const failing = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
      h0Criteria: { minAccuracy: 0.99, minNoulF1: 0.99, minMedianConfidence: 0.99 },
    });
    expect(failing.serializers[0]!.h0Prime.verdict).toBe("FAIL");
    expect(failing.serializers[0]!.h0Prime.reasons.length).toBeGreaterThan(0);
  });

  it("excludes hunks with no ground truth label and includes failed hunks' errors nowhere but skips them cleanly", () => {
    const partial = results.filter((r) => r.hunkId !== "h8");
    const failures: ProfileHunkFailure[] = [{ hunkId: "h8", batchIndex: 0, error: "boom" }];
    const report = buildProfileReport({ "raw-diff": runOf(partial, failures) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    expect(report.serializers[0]!.sampleCount).toBe(7);
  });

  it("defaults datasetVersion to 1 and accepts an override", () => {
    const withDefault = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    expect(withDefault.datasetVersion).toBe(1);
    const withOverride = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
      datasetVersion: 2,
    });
    expect(withOverride.datasetVersion).toBe(2);
  });

  it("uses an injectable clock for generatedAt", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
      now: () => fixed,
    });
    expect(report.generatedAt).toBe(fixed.toISOString());
  });
});

describe("renderProfileReportMarkdown", () => {
  it("includes the choice accuracy table, noul table, and H0' verdict", () => {
    const report = buildProfileReport({ "raw-diff": runOf(results) }, labelsByHunkId, {
      thresholds: [0.5],
    });
    const markdown = renderProfileReportMarkdown(report);
    expect(markdown).toContain("raw-diff");
    expect(markdown).toContain("change_kind");
    expect(markdown).toContain("touches_io");
    expect(markdown).toMatch(/H0'/);
    expect(markdown).toMatch(/does not block/i);
  });
});
