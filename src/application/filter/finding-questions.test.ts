import { describe, expect, it } from "vitest";
import { fanOutKey, parseFanOutKey } from "../spike/questions.js";
import {
  actionableQuestion,
  buildFindingFanOut,
  buildFindingState,
  filterQuestionSet,
  isRealDefectQuestion,
  isStyleOnlyQuestion,
  severityQuestion,
} from "./finding-questions.js";
import type { FindingRecord } from "./finding-record.js";

function makeFinding(
  id: string,
  hunkId: string,
  overrides: Partial<FindingRecord> = {},
): FindingRecord {
  return {
    id,
    hunkId,
    datasetVersion: 2,
    reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
    file: "src/thing.ts",
    lineStart: 10,
    lineEnd: 12,
    claim: "off-by-one in the loop bound",
    rationale: "The loop uses <= instead of < against the array length.",
    suggestedSeverity: "major",
    label: { real: true, source: "line-overlap", overlapLines: 2, fixChangedLines: 3 },
    needsManualReview: true,
    usage: { inputTokens: 400, outputTokens: 60 },
    costUsd: 0.0009,
    latencyMs: 900,
    ...overrides,
  };
}

describe("question builders", () => {
  it("isRealDefectQuestion is a noul with true/false criteria", () => {
    const q = isRealDefectQuestion();
    expect(q.type).toBe("noul");
    if (q.type === "noul") {
      expect(q.criteria?.true).toBeTruthy();
      expect(q.criteria?.false).toBeTruthy();
    }
  });

  it("severityQuestion is a 4-level score: nit/minor/major/critical", () => {
    const q = severityQuestion();
    expect(q.type).toBe("score");
    if (q.type === "score") {
      expect(q.criteria).toHaveLength(4);
    }
  });

  it("isStyleOnlyQuestion and actionableQuestion are nouls with explicit criteria", () => {
    for (const build of [isStyleOnlyQuestion, actionableQuestion]) {
      const q = build();
      expect(q.type).toBe("noul");
      if (q.type === "noul") {
        expect(q.criteria?.true).toBeTruthy();
        expect(q.criteria?.false).toBeTruthy();
      }
    }
  });
});

describe("filterQuestionSet", () => {
  it("is named 'filter' with the four questions", () => {
    expect(filterQuestionSet.name).toBe("filter");
    expect(filterQuestionSet.questions.map((q) => q.name).sort()).toEqual(
      ["is_real_defect", "severity", "is_style_only", "actionable"].sort(),
    );
  });
});

describe("buildFindingState", () => {
  it("builds state with only hunk diff and finding claim/rationale/file/lines", () => {
    const finding = makeFinding("f1", "h1");
    const state = buildFindingState(finding, "@@ -1,2 +1,2 @@\n-a\n+b");
    expect(state).toEqual({
      hunk: "@@ -1,2 +1,2 @@\n-a\n+b",
      finding: {
        claim: "off-by-one in the loop bound",
        rationale: "The loop uses <= instead of < against the array length.",
        file: "src/thing.ts",
        lines: { start: 10, end: 12 },
      },
    });
  });

  it("never leaks the label, reviewer, cost, or severity into state", () => {
    const finding = makeFinding("f1", "h1");
    const state = buildFindingState(finding, "diff text");
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/label/i);
    expect(serialized).not.toMatch(/reviewer/i);
    expect(serialized).not.toMatch(/cost/i);
    expect(serialized).not.toMatch(/severity/i);
  });
});

describe("buildFindingFanOut", () => {
  const hunksById = new Map([
    ["h1", "@@ -1,2 +1,2 @@\n-a\n+b"],
    ["h2", "@@ -3,2 +3,2 @@\n-c\n+d"],
  ]);

  it("chunks findings into batches of the given size", () => {
    const findings = [makeFinding("f1", "h1"), makeFinding("f2", "h1"), makeFinding("f3", "h2")];
    const batches = buildFindingFanOut(findings, hunksById, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.findingIds).toEqual(["f1", "f2"]);
    expect(batches[1]!.findingIds).toEqual(["f3"]);
  });

  it("keys state by finding id and questions by fanOutKey(findingId, questionName)", () => {
    const findings = [makeFinding("f1", "h1")];
    const [batch] = buildFindingFanOut(findings, hunksById, 10);
    expect(Object.keys(batch!.state)).toEqual(["f1"]);
    const questionKeys = Object.keys(batch!.questions).sort();
    expect(questionKeys).toEqual(
      ["f1__is_real_defect", "f1__severity", "f1__is_style_only", "f1__actionable"].sort(),
    );
    expect(parseFanOutKey(fanOutKey("f1", "severity"), ["severity"])).toEqual({
      hunkId: "f1",
      questionName: "severity",
    });
  });

  it("throws a clear error when a finding references an unknown hunk", () => {
    const findings = [makeFinding("f1", "does-not-exist")];
    expect(() => buildFindingFanOut(findings, hunksById, 10)).toThrow(/does-not-exist/);
  });

  it("throws for a non-positive batch size", () => {
    expect(() => buildFindingFanOut([makeFinding("f1", "h1")], hunksById, 0)).toThrow(RangeError);
  });

  it("returns an empty array for an empty finding list", () => {
    expect(buildFindingFanOut([], hunksById, 10)).toEqual([]);
  });
});
