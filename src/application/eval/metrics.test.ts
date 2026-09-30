import { describe, expect, it } from "vitest";
import type { GoldenIssue } from "./golden-set.js";
import type { MatchedCandidate } from "./match-candidates.js";
import {
  SEVERITY_WEIGHTS,
  VERDICT_WEIGHTS,
  aggregateMetrics,
  computeCaseMetrics,
} from "./metrics.js";

function issue(
  id: string,
  verdict: GoldenIssue["verdict"],
  severity: GoldenIssue["severity"],
): GoldenIssue {
  return { id, file: "a.ts", line: 1, title: id, severity, verdict };
}

function cand(
  id: string,
  issueId: string | null,
  bucket: MatchedCandidate["bucket"] = "shown",
): MatchedCandidate {
  return { id, file: "a.ts", line: 1, text: id, bucket, source: "import", issueId };
}

const ISSUES = [
  issue("R1", "real", "high"),
  issue("R2", "real", "low"),
  issue("P1", "partly", "medium"),
  issue("F1", "false", "low"),
  issue("U1", "unverifiable", "low"),
];

describe("weights", () => {
  it("are the documented constants", () => {
    expect(VERDICT_WEIGHTS).toEqual({ real: 1, partly: 0.5 });
    expect(SEVERITY_WEIGHTS).toEqual({ critical: 4, high: 3, medium: 2, low: 1 });
  });
});

describe("computeCaseMetrics", () => {
  const matched = [
    cand("c1", "R1"),
    cand("c2", "R1"),
    cand("c3", "F1"),
    cand("c4", null),
    cand("c5", "U1"),
    cand("c6", "P1", "low"),
    cand("c7", null, "low"),
  ];
  const metrics = computeCaseMetrics({
    caseId: "case-1",
    issues: ISSUES,
    matched,
    costUsd: 0.5,
    tokens: 1000,
    wallTimeMs: 2000,
  });

  it("scores the shown bucket", () => {
    const shown = metrics.shown;
    expect(shown.candidates).toBe(5);
    expect(shown.targets).toBe(3);
    expect(shown.targetsFound).toBe(1);
    expect(shown.recall).toBeCloseTo(1 / 3);
    // R1 found: 1*3; all targets: 1*3 + 1*1 + 0.5*2 = 5.
    expect(shown.weightedFound).toBeCloseTo(3);
    expect(shown.weightedTotal).toBeCloseTo(5);
    expect(shown.weightedRecall).toBeCloseTo(0.6);
    expect(shown.realBySeverity).toEqual({
      critical: { found: 0, total: 0 },
      high: { found: 1, total: 1 },
      medium: { found: 0, total: 0 },
      low: { found: 0, total: 1 },
    });
    expect(shown.knownFalse).toBe(1);
    expect(shown.unverifiable).toBe(1);
    expect(shown.unlabeled).toBe(1);
    expect(shown.matchedTargets).toBe(2);
    expect(shown.precisionLowerBound).toBeCloseTo(2 / 5);
  });

  it("adds the low bucket in the all view", () => {
    const all = metrics.all;
    expect(all.candidates).toBe(7);
    expect(all.targetsFound).toBe(2);
    expect(all.weightedFound).toBeCloseTo(4);
    expect(all.unlabeled).toBe(2);
  });

  it("carries cost, tokens and wall time", () => {
    expect(metrics).toMatchObject({ costUsd: 0.5, tokens: 1000, wallTimeMs: 2000 });
  });

  it("has null ratios when there is nothing to find or nothing shown", () => {
    const empty = computeCaseMetrics({
      caseId: "e",
      issues: [issue("F1", "false", "low")],
      matched: [],
      costUsd: null,
      tokens: null,
      wallTimeMs: null,
    });
    expect(empty.shown.recall).toBeNull();
    expect(empty.shown.weightedRecall).toBeNull();
    expect(empty.shown.precisionLowerBound).toBeNull();
  });
});

describe("aggregateMetrics", () => {
  it("sums counts across cases and recomputes the ratios (micro average)", () => {
    const a = computeCaseMetrics({
      caseId: "a",
      issues: [issue("R1", "real", "high")],
      matched: [cand("x", "R1")],
      costUsd: 1,
      tokens: 10,
      wallTimeMs: 5,
    });
    const b = computeCaseMetrics({
      caseId: "b",
      issues: [issue("R1", "real", "low"), issue("R2", "real", "low")],
      matched: [cand("y", null)],
      costUsd: null,
      tokens: 5,
      wallTimeMs: 7,
    });
    const total = aggregateMetrics([a, b]);
    expect(total.shown.targets).toBe(3);
    expect(total.shown.targetsFound).toBe(1);
    expect(total.shown.recall).toBeCloseTo(1 / 3);
    expect(total.shown.weightedRecall).toBeCloseTo(3 / 5);
    expect(total.shown.realBySeverity.low).toEqual({ found: 0, total: 2 });
    expect(total.shown.precisionLowerBound).toBeCloseTo(1 / 2);
    expect(total.costUsd).toBe(1);
    expect(total.costKnownForAllCases).toBe(false);
    expect(total.casesWithCost).toBe(1);
    expect(total.tokens).toBe(15);
    expect(total.wallTimeMs).toBe(12);
    expect(total.cases).toBe(2);
  });
});
