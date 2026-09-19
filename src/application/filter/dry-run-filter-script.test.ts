import { describe, expect, it } from "vitest";
import type { Decision } from "../../domain/decision.js";
import { fanOutKey } from "../spike/questions.js";
import { generateDryRunFilterScript } from "./dry-run-filter-script.js";
import type { FindingRecord } from "./finding-record.js";

function makeFinding(id: string): FindingRecord {
  return {
    id,
    hunkId: "h1",
    datasetVersion: 2,
    reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
    file: "src/thing.ts",
    lineStart: 1,
    lineEnd: 2,
    claim: "x",
    rationale: "y",
    suggestedSeverity: "minor",
    label: { real: true, source: "line-overlap", overlapLines: 1, fixChangedLines: 1 },
    needsManualReview: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
  };
}

describe("generateDryRunFilterScript", () => {
  it("covers the four filter questions for every finding", () => {
    const findings = [makeFinding("f1"), makeFinding("f2")];
    const script = generateDryRunFilterScript(findings, 1);
    const expectedKeys = ["f1", "f2"].flatMap((id) => [
      fanOutKey(id, "is_real_defect"),
      fanOutKey(id, "severity"),
      fanOutKey(id, "is_style_only"),
      fanOutKey(id, "actionable"),
    ]);
    expect(Object.keys(script).sort()).toEqual(expectedKeys.sort());
  });

  it("is deterministic for the same seed", () => {
    const findings = [makeFinding("f1")];
    expect(generateDryRunFilterScript(findings, 5)).toEqual(
      generateDryRunFilterScript(findings, 5),
    );
  });

  it("differs for a different seed", () => {
    const findings = [makeFinding("f1")];
    expect(generateDryRunFilterScript(findings, 1)).not.toEqual(
      generateDryRunFilterScript(findings, 2),
    );
  });

  it("generates nouls in [0,1] and a severity score in [0,3]", () => {
    const findings = [makeFinding("f1")];
    const script = generateDryRunFilterScript(findings, 3);
    const isReal = script[fanOutKey("f1", "is_real_defect")] as Decision & { type: "noul" };
    expect(isReal.noul).toBeGreaterThanOrEqual(0);
    expect(isReal.noul).toBeLessThanOrEqual(1);
    const severity = script[fanOutKey("f1", "severity")] as Decision & { type: "score" };
    expect(severity.score).toBeGreaterThanOrEqual(0);
    expect(severity.score).toBeLessThanOrEqual(3);
  });

  it("returns an empty script for an empty finding list", () => {
    expect(generateDryRunFilterScript([], 1)).toEqual({});
  });
});
