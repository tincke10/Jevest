import { describe, expect, it } from "vitest";
import type { FindingRecord } from "../filter/finding-record.js";
import type { OracleLabelResult, OracleRunResult } from "./oracle-label.js";
import { buildOracleReport, renderOracleReportMarkdown } from "./oracle-report.js";

function finding(id: string, lineOverlapReal: boolean): FindingRecord {
  return {
    id,
    hunkId: "h1",
    datasetVersion: 2,
    reviewer: { provider: "claude-cli", model: "claude-opus-5" },
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 2,
    claim: "c",
    rationale: "r",
    suggestedSeverity: "minor",
    label: {
      real: lineOverlapReal,
      source: "line-overlap",
      overlapLines: lineOverlapReal ? 1 : 0,
      fixChangedLines: 3,
    },
    needsManualReview: true,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    latencyMs: 1,
  };
}

function result(id: string, verdict: "real" | "noise" | "unknown"): OracleLabelResult {
  return {
    findingId: id,
    verdict,
    labelerModel: "deepseek-v4-pro",
    fixMatch: { verdict: "real", confidence: 0.9, reason: "a" },
    claimVerification: { verdict: "present", confidence: 0.8, reason: "b" },
    costUsd: 0.002,
    latencyMs: 4000,
  };
}

function run(results: OracleLabelResult[]): OracleRunResult {
  return {
    results,
    failures: [],
    totals: {
      requests: results.length * 2,
      totalCostUsd: results.length * 0.002,
      wallTimeMs: 1000,
    },
    stoppedEarly: false,
  };
}

const FINDINGS = [
  finding("f1", true),
  finding("f2", true),
  finding("f3", false),
  finding("f4", false),
  finding("f5", false),
];

const RESULTS = [
  result("f1", "real"),
  result("f2", "noise"),
  result("f3", "real"),
  result("f4", "noise"),
  result("f5", "unknown"),
];

describe("buildOracleReport", () => {
  it("cross-tabs the line-overlap label against the oracle label", () => {
    const report = buildOracleReport(run(RESULTS), FINDINGS, {
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    expect(report.crossTab).toEqual({
      lineOverlapReal: { real: 1, noise: 1, unknown: 0 },
      lineOverlapNoise: { real: 1, noise: 1, unknown: 1 },
    });
  });

  it("reports how often the two labels agree, over the decisive oracle verdicts only", () => {
    const report = buildOracleReport(run(RESULTS), FINDINGS, {
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    // f1 real/real and f4 noise/noise agree; f2 and f3 disagree; f5 is unknown.
    expect(report.comparableCount).toBe(4);
    expect(report.labelAgreementRate).toBeCloseTo(0.5, 6);
  });

  it("carries the run summary and the labeler model", () => {
    const report = buildOracleReport(run(RESULTS), FINDINGS, {
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    expect(report.summary.counts).toEqual({ real: 2, noise: 2, unknown: 1 });
    expect(report.summary.labelerModel).toBe("deepseek-v4-pro");
    expect(report.generatedAt).toBe("2026-09-22T12:00:00.000Z");
  });

  it("never divides by zero when every verdict is unknown", () => {
    const report = buildOracleReport(run([result("f1", "unknown")]), [finding("f1", true)], {
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    expect(report.comparableCount).toBe(0);
    expect(report.labelAgreementRate).toBe(0);
  });
});

describe("renderOracleReportMarkdown", () => {
  it("prints the counts, the cross-tab and the labeler model", () => {
    const markdown = renderOracleReportMarkdown(
      buildOracleReport(run(RESULTS), FINDINGS, {
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      }),
    );
    expect(markdown).toContain("Fix-aware oracle label");
    expect(markdown).toContain("deepseek-v4-pro");
    expect(markdown).toContain("line-overlap × oracle");
    expect(markdown).toContain("unknown");
  });

  it("says out loud that unknown findings are excluded from H1 scoring", () => {
    const markdown = renderOracleReportMarkdown(
      buildOracleReport(run(RESULTS), FINDINGS, {
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      }),
    );
    expect(markdown).toMatch(/excluded/i);
  });
});
