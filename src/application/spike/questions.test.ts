import { describe, expect, it } from "vitest";
import type { HunkRecord } from "./hunk-record.js";
import { defectQuestionSet } from "./question-sets/defect.js";
import { FanOutKeyError, buildFanOut, fanOutKey, parseFanOutKey } from "./questions.js";
import { beforeAfterJson, jsonWithContext, rawDiff } from "./serializers.js";

const DEFECT_QUESTION_NAMES = defectQuestionSet.questions.map((q) => q.name);

function makeHunk(id: string): HunkRecord {
  return {
    id,
    repo: "owner/repo",
    license: "MIT",
    commit: "abc123",
    parent: "def456",
    file: "src/thing.ts",
    language: "typescript",
    hunkHeader: "@@ -1,3 +1,4 @@",
    before: "const a = 1;",
    after: "const a = 2;",
    diff: "@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2;",
    label: {
      defect: true,
      category: "bugfix",
      touchesPublicApi: null,
      touchesSecurity: false,
      source: "commit-heuristic",
    },
    evidence: {
      commitMessage: "fix: correct off-by-one",
      issueUrl: null,
      prUrl: "https://github.com/owner/repo/pull/1",
    },
    needsManualReview: true,
    datasetVersion: 1,
  };
}

describe("fanOutKey / parseFanOutKey", () => {
  it("round-trips a hunk id and question name", () => {
    const key = fanOutKey("zod-9446b5c-1", "defect_likelihood");
    expect(parseFanOutKey(key, DEFECT_QUESTION_NAMES)).toEqual({
      hunkId: "zod-9446b5c-1",
      questionName: "defect_likelihood",
    });
  });

  it("round-trips a hunk id that itself contains the '__' separator", () => {
    const key = fanOutKey("weird__id__with__underscores", "touches_security");
    expect(parseFanOutKey(key, DEFECT_QUESTION_NAMES)).toEqual({
      hunkId: "weird__id__with__underscores",
      questionName: "touches_security",
    });
  });

  it("throws FanOutKeyError for a key with no recognizable question suffix", () => {
    expect(() => parseFanOutKey("not-a-fanout-key", DEFECT_QUESTION_NAMES)).toThrow(FanOutKeyError);
  });

  it("works with an arbitrary set of question names, not just the defect set", () => {
    const key = fanOutKey("hunk-1", "change_kind");
    expect(parseFanOutKey(key, ["change_kind", "touches_io"])).toEqual({
      hunkId: "hunk-1",
      questionName: "change_kind",
    });
  });
});

describe("buildFanOut", () => {
  it("chunks hunks into batches of the given size", () => {
    const hunks = [makeHunk("a"), makeHunk("b"), makeHunk("c"), makeHunk("d"), makeHunk("e")];
    const batches = buildFanOut(hunks, beforeAfterJson, 2, defectQuestionSet);
    expect(batches).toHaveLength(3);
    expect(batches[0]!.hunkIds).toEqual(["a", "b"]);
    expect(batches[1]!.hunkIds).toEqual(["c", "d"]);
    expect(batches[2]!.hunkIds).toEqual(["e"]);
  });

  it("produces a single batch when batchSize >= hunk count", () => {
    const hunks = [makeHunk("a"), makeHunk("b")];
    const batches = buildFanOut(hunks, beforeAfterJson, 10, defectQuestionSet);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.hunkIds).toEqual(["a", "b"]);
  });

  it("produces one batch per hunk when batchSize is 1", () => {
    const hunks = [makeHunk("a"), makeHunk("b"), makeHunk("c")];
    const batches = buildFanOut(hunks, beforeAfterJson, 1, defectQuestionSet);
    expect(batches).toHaveLength(3);
  });

  it("returns an empty array for an empty hunk list", () => {
    expect(buildFanOut([], beforeAfterJson, 10, defectQuestionSet)).toEqual([]);
  });

  it("throws for a non-positive batch size", () => {
    expect(() => buildFanOut([makeHunk("a")], beforeAfterJson, 0, defectQuestionSet)).toThrow(
      RangeError,
    );
    expect(() => buildFanOut([makeHunk("a")], beforeAfterJson, -1, defectQuestionSet)).toThrow(
      RangeError,
    );
  });

  it("keys state by hunk id and questions by '${hunkId}__${questionName}' for every question in the set", () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const [batch] = buildFanOut(hunks, beforeAfterJson, 10, defectQuestionSet);

    expect(Object.keys(batch!.state).sort()).toEqual(["h1", "h2"]);
    expect(batch!.state.h1).toEqual(beforeAfterJson.serialize(hunks[0]!));

    const questionKeys = Object.keys(batch!.questions).sort();
    const expectedKeys = ["h1", "h2"].flatMap((id) =>
      DEFECT_QUESTION_NAMES.map((name) => `${id}__${name}`),
    );
    expect(questionKeys).toEqual(expectedKeys.sort());
  });

  it("never leaks label, evidence, or commit_message strings into the fan-out state", () => {
    const hunks = [makeHunk("h1")];
    for (const serializer of [rawDiff, beforeAfterJson, jsonWithContext]) {
      const [batch] = buildFanOut(hunks, serializer, 10, defectQuestionSet);
      const serialized = JSON.stringify(batch!.state);
      expect(serialized).not.toMatch(/defect/i);
      expect(serialized).not.toMatch(/evidence/i);
      expect(serialized).not.toMatch(/commit_message/i);
    }
  });
});
