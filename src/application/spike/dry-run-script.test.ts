import { describe, expect, it } from "vitest";
import type { Decision } from "../../domain/decision.js";
import { generateDryRunScript } from "./dry-run-script.js";
import type { HunkRecord } from "./hunk-record.js";
import { fanOutKey } from "./questions.js";

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
    datasetVersion: 1,
  };
}

describe("generateDryRunScript", () => {
  it("covers exactly the three fan-out questions for every hunk", () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const script = generateDryRunScript(hunks, 1);

    const expectedKeys = [
      fanOutKey("h1", "defect_likelihood"),
      fanOutKey("h1", "touches_public_api"),
      fanOutKey("h1", "touches_security"),
      fanOutKey("h2", "defect_likelihood"),
      fanOutKey("h2", "touches_public_api"),
      fanOutKey("h2", "touches_security"),
    ];
    expect(Object.keys(script).sort()).toEqual(expectedKeys.sort());
  });

  it("is deterministic: the same seed and hunks produce identical decisions", () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const a = generateDryRunScript(hunks, 42);
    const b = generateDryRunScript(hunks, 42);
    expect(a).toEqual(b);
  });

  it("produces different decisions for a different seed", () => {
    const hunks = [makeHunk("h1")];
    const a = generateDryRunScript(hunks, 1);
    const b = generateDryRunScript(hunks, 2);
    expect(a).not.toEqual(b);
  });

  it("generates a noul in [0,1] for touches_public_api and touches_security", () => {
    const hunks = [makeHunk("h1")];
    const script = generateDryRunScript(hunks, 7);
    const api = script[fanOutKey("h1", "touches_public_api")] as Decision & { type: "noul" };
    const sec = script[fanOutKey("h1", "touches_security")] as Decision & { type: "noul" };
    expect(api.type).toBe("noul");
    expect(api.noul).toBeGreaterThanOrEqual(0);
    expect(api.noul).toBeLessThanOrEqual(1);
    expect(sec.type).toBe("noul");
    expect(sec.noul).toBeGreaterThanOrEqual(0);
    expect(sec.noul).toBeLessThanOrEqual(1);
  });

  it("generates a score in [0,3] with a 4-entry legend and probabilities that sum to ~1", () => {
    const hunks = [makeHunk("h1")];
    const script = generateDryRunScript(hunks, 7);
    const defect = script[fanOutKey("h1", "defect_likelihood")] as Decision & { type: "score" };
    expect(defect.type).toBe("score");
    expect(defect.score).toBeGreaterThanOrEqual(0);
    expect(defect.score).toBeLessThanOrEqual(3);
    expect(Object.keys(defect.legend)).toHaveLength(4);
    const sum = Object.values(defect.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("returns an empty script for an empty hunk list", () => {
    expect(generateDryRunScript([], 1)).toEqual({});
  });
});
