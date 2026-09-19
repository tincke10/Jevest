import { describe, expect, it } from "vitest";
import type { HunkRecord } from "./hunk-record.js";
import { stratifiedSample } from "./stratified-sample.js";

function makeHunk(id: string, defect: boolean): HunkRecord {
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
    datasetVersion: 1,
    label: {
      defect,
      category: defect ? "bugfix" : "docs",
      touchesPublicApi: null,
      touchesSecurity: null,
      source: "commit-heuristic",
    },
    evidence: { commitMessage: defect ? "fix: x" : "docs: x", issueUrl: null, prUrl: null },
    needsManualReview: true,
  };
}

const defects = Array.from({ length: 10 }, (_, i) => makeHunk(`d${i}`, true));
const benign = Array.from({ length: 10 }, (_, i) => makeHunk(`b${i}`, false));
const hunks = [...defects, ...benign];

describe("stratifiedSample", () => {
  it("picks half defect / half benign for an even limit", () => {
    const sample = stratifiedSample(hunks, { limit: 6, seed: 42 });
    expect(sample).toHaveLength(6);
    expect(sample.filter((h) => h.label.defect)).toHaveLength(3);
    expect(sample.filter((h) => !h.label.defect)).toHaveLength(3);
  });

  it("gives the extra hunk to defect for an odd limit", () => {
    const sample = stratifiedSample(hunks, { limit: 5, seed: 42 });
    expect(sample).toHaveLength(5);
    expect(sample.filter((h) => h.label.defect)).toHaveLength(3);
    expect(sample.filter((h) => !h.label.defect)).toHaveLength(2);
  });

  it("is deterministic: same hunks, limit, and seed produce the same selection", () => {
    const a = stratifiedSample(hunks, { limit: 6, seed: 42 });
    const b = stratifiedSample(hunks, { limit: 6, seed: 42 });
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
  });

  it("selects a different subset for a different seed", () => {
    const a = stratifiedSample(hunks, { limit: 6, seed: 1 });
    const b = stratifiedSample(hunks, { limit: 6, seed: 2 });
    expect(a.map((h) => h.id)).not.toEqual(b.map((h) => h.id));
  });

  it("preserves the original dataset order of the selected hunks", () => {
    const sample = stratifiedSample(hunks, { limit: 6, seed: 42 });
    const originalOrder = hunks.filter((h) => sample.includes(h));
    expect(sample.map((h) => h.id)).toEqual(originalOrder.map((h) => h.id));
  });

  it("backfills from the other class when one class runs short", () => {
    const scarceBenign = [...defects, makeHunk("only-benign", false)];
    const sample = stratifiedSample(scarceBenign, { limit: 8, seed: 42 });
    expect(sample).toHaveLength(8); // 1 benign available + 7 backfilled from defect
    expect(sample.filter((h) => !h.label.defect)).toHaveLength(1);
    expect(sample.filter((h) => h.label.defect)).toHaveLength(7);
  });

  it("returns every hunk unchanged when limit >= dataset size", () => {
    const sample = stratifiedSample(hunks, { limit: 100, seed: 42 });
    expect(sample.map((h) => h.id)).toEqual(hunks.map((h) => h.id));
  });

  it("returns an empty array for limit 0", () => {
    expect(stratifiedSample(hunks, { limit: 0, seed: 42 })).toEqual([]);
  });

  it("throws for a negative limit", () => {
    expect(() => stratifiedSample(hunks, { limit: -1, seed: 42 })).toThrow(RangeError);
  });
});
