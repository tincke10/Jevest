import { describe, expect, it } from "vitest";
import type { Decision } from "../../domain/decision.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { PROFILE_CHANGE_KINDS } from "../spike/question-sets/profile.js";
import { fanOutKey } from "../spike/questions.js";
import { generateDryRunProfileScript } from "./dry-run-profile-script.js";

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
    evidence: { commitMessage: "fix: x", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
  };
}

describe("generateDryRunProfileScript", () => {
  it("covers exactly the five profile questions for every hunk", () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const script = generateDryRunProfileScript(hunks, 1);
    const expectedKeys = ["h1", "h2"].flatMap((id) => [
      fanOutKey(id, "change_kind"),
      fanOutKey(id, "touches_public_api"),
      fanOutKey(id, "touches_error_handling"),
      fanOutKey(id, "touches_async"),
      fanOutKey(id, "touches_io"),
    ]);
    expect(Object.keys(script).sort()).toEqual(expectedKeys.sort());
  });

  it("is deterministic for the same seed and hunks", () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    expect(generateDryRunProfileScript(hunks, 42)).toEqual(generateDryRunProfileScript(hunks, 42));
  });

  it("differs for a different seed", () => {
    const hunks = [makeHunk("h1")];
    expect(generateDryRunProfileScript(hunks, 1)).not.toEqual(
      generateDryRunProfileScript(hunks, 2),
    );
  });

  it("picks a valid change_kind choice with probabilities summing to ~1", () => {
    const hunks = [makeHunk("h1")];
    const script = generateDryRunProfileScript(hunks, 7);
    const decision = script[fanOutKey("h1", "change_kind")] as Decision & { type: "choice" };
    expect(decision.type).toBe("choice");
    expect(PROFILE_CHANGE_KINDS).toContain(decision.choice);
    const sum = Object.values(decision.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("generates nouls in [0,1]", () => {
    const hunks = [makeHunk("h1")];
    const script = generateDryRunProfileScript(hunks, 7);
    for (const name of [
      "touches_public_api",
      "touches_error_handling",
      "touches_async",
      "touches_io",
    ]) {
      const decision = script[fanOutKey("h1", name)] as Decision & { type: "noul" };
      expect(decision.type).toBe("noul");
      expect(decision.noul).toBeGreaterThanOrEqual(0);
      expect(decision.noul).toBeLessThanOrEqual(1);
    }
  });

  it("returns an empty script for an empty hunk list", () => {
    expect(generateDryRunProfileScript([], 1)).toEqual({});
  });
});
