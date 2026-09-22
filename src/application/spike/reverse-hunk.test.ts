import { describe, expect, it } from "vitest";
import type { HunkRecord } from "./hunk-record.js";
import {
  reverseHunkJsonl,
  reverseHunkRecord,
  reverseUnifiedDiff,
  reviewerViewOfHunk,
} from "./reverse-hunk.js";

const THREE_LINE_DIFF = [
  "@@ -10,3 +10,4 @@ function f(",
  "   const a = 1;",
  "-  return a;",
  "+  if (a === 0) return 0;",
  "+  return a + 1;",
].join("\n");

// Removals before additions inside the change block, exactly as `git diff`
// would render the reverse patch.
const THREE_LINE_REVERSED = [
  "@@ -10,4 +10,3 @@ function f(",
  "   const a = 1;",
  "-  if (a === 0) return 0;",
  "-  return a + 1;",
  "+  return a;",
].join("\n");

describe("reverseUnifiedDiff", () => {
  it("swaps the +/- bodies and the old/new ranges of a hand-written 3-line diff", () => {
    expect(reverseUnifiedDiff(THREE_LINE_DIFF)).toBe(THREE_LINE_REVERSED);
  });

  it("round-trips: reverse(reverse(d)) === d", () => {
    expect(reverseUnifiedDiff(reverseUnifiedDiff(THREE_LINE_DIFF))).toBe(THREE_LINE_DIFF);
  });

  it("leaves context lines and blank context lines untouched", () => {
    const diff = ["@@ -1,2 +1,2 @@", " keep", "", "-old", "+new"].join("\n");
    expect(reverseUnifiedDiff(diff)).toBe(
      ["@@ -1,2 +1,2 @@", " keep", "", "-new", "+old"].join("\n"),
    );
  });

  it("keeps the function-context suffix of the @@ header verbatim", () => {
    expect(reverseUnifiedDiff("@@ -1268,13 +1200,20 @@ function generateObjectCheck(")).toBe(
      "@@ -1200,20 +1268,13 @@ function generateObjectCheck(",
    );
  });

  it("swaps a range with no count and a header with no suffix", () => {
    expect(reverseUnifiedDiff("@@ -1 +1,2 @@")).toBe("@@ -1,2 +1 @@");
  });

  it("swaps --- / +++ file headers as a pair, before any body line", () => {
    const diff = ["--- a/src/thing.ts", "+++ b/src/thing.ts", "@@ -1,1 +1,1 @@", "-a", "+b"].join(
      "\n",
    );
    const reversed = reverseUnifiedDiff(diff);
    expect(reversed.split("\n").slice(0, 2)).toEqual(["--- b/src/thing.ts", "+++ a/src/thing.ts"]);
    expect(reverseUnifiedDiff(reversed)).toBe(diff);
  });

  it("handles a multi-hunk diff, reversing every @@ header", () => {
    const diff = ["@@ -1,2 +1,3 @@", "-a", "+b", "+c", "@@ -20,1 +21,2 @@ ctx", "-d", "+e"].join(
      "\n",
    );
    expect(reverseUnifiedDiff(diff)).toBe(
      ["@@ -1,3 +1,2 @@", "-b", "-c", "+a", "@@ -21,2 +20,1 @@ ctx", "-e", "+d"].join("\n"),
    );
  });

  it("preserves a trailing newline exactly", () => {
    expect(reverseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n+b\n")).toBe("@@ -1,1 +1,1 @@\n-b\n+a\n");
  });

  it("throws on a malformed @@ header rather than passing it through", () => {
    expect(() => reverseUnifiedDiff("@@ nonsense @@\n-a\n+b")).toThrow(/@@/);
  });

  it("regroups each change block so removals precede additions, as git emits them", () => {
    // "-a -b +c" reversed is the patch that removes c and adds a and b; git
    // would render that as "-c +a +b", never "+a +b -c".
    const diff = ["@@ -1,3 +1,2 @@", " ctx", "-a", "-b", "+c", " tail"].join("\n");
    expect(reverseUnifiedDiff(diff)).toBe(
      ["@@ -1,2 +1,3 @@", " ctx", "-c", "+a", "+b", " tail"].join("\n"),
    );
  });

  it("regroups independently per change block, keeping context between them", () => {
    const diff = ["@@ -1,4 +1,4 @@", "-a", "+b", " ctx", "-c", "-d", "+e"].join("\n");
    expect(reverseUnifiedDiff(diff)).toBe(
      ["@@ -1,4 +1,4 @@", "-b", "+a", " ctx", "-e", "+c", "+d"].join("\n"),
    );
  });

  it("round-trips a block that needed regrouping", () => {
    const diff = ["@@ -1,3 +1,2 @@", " ctx", "-a", "-b", "+c"].join("\n");
    expect(reverseUnifiedDiff(reverseUnifiedDiff(diff))).toBe(diff);
  });

  it("keeps the no-newline marker attached to the block it follows", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    expect(reverseUnifiedDiff(diff)).toBe(
      ["@@ -1,1 +1,1 @@", "-b", "+a", "\\ No newline at end of file"].join("\n"),
    );
  });
});

function defectRecord(overrides: Partial<HunkRecord> = {}): HunkRecord {
  return {
    id: "repo-abc123-1",
    repo: "owner/repo",
    license: "MIT",
    commit: "abc123",
    parent: "def456",
    file: "src/thing.ts",
    language: "typescript",
    hunkHeader: "@@ -10,3 +10,4 @@ function f(",
    before: "before code",
    after: "after code",
    diff: THREE_LINE_DIFF,
    label: {
      defect: true,
      category: "bugfix",
      touchesPublicApi: null,
      touchesSecurity: null,
      source: "commit-heuristic",
    },
    evidence: { commitMessage: "fix: thing", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
    ...overrides,
  };
}

describe("reverseHunkRecord", () => {
  it("reverses a defect record: new id, provenance, orientation and a reversed diff", () => {
    const reversed = reverseHunkRecord(defectRecord());
    expect(reversed.id).toBe("repo-abc123-1-rev");
    expect(reversed.reversedFrom).toBe("repo-abc123-1");
    expect(reversed.orientation).toBe("reversed");
    expect(reversed.diff).toBe(THREE_LINE_REVERSED);
  });

  it("keeps before, after, label, evidence and the hunk header in ORIGINAL orientation", () => {
    const original = defectRecord();
    const reversed = reverseHunkRecord(original);
    expect(reversed.before).toBe("before code");
    expect(reversed.after).toBe("after code");
    expect(reversed.hunkHeader).toBe(original.hunkHeader);
    expect(reversed.label).toEqual(original.label);
    expect(reversed.evidence).toEqual(original.evidence);
    expect(reversed.file).toBe(original.file);
    expect(reversed.language).toBe(original.language);
    expect(reversed.repo).toBe(original.repo);
    expect(reversed.commit).toBe(original.commit);
    expect(reversed.parent).toBe(original.parent);
    expect(reversed.needsManualReview).toBe(true);
  });

  it("refuses to reverse a benign record: there is no defect to reveal", () => {
    const benign = defectRecord({
      label: { ...defectRecord().label, defect: false, category: "refactor" },
    });
    expect(() => reverseHunkRecord(benign)).toThrow(/benign/);
  });
});

describe("reviewerViewOfHunk", () => {
  it("shows an original hunk exactly as recorded", () => {
    const hunk = defectRecord();
    expect(reviewerViewOfHunk(hunk)).toEqual({
      before: "before code",
      hunkHeader: "@@ -10,3 +10,4 @@ function f(",
      diff: THREE_LINE_DIFF,
    });
  });

  it("shows a reversed hunk the FIXED code as its pre-image, not the buggy code", () => {
    // The reversed diff goes fixed -> buggy, so "the code before the change"
    // is the fixed code. Showing `before` there would hand the reviewer a
    // pre-image that contradicts the diff sitting under it.
    const view = reviewerViewOfHunk(reverseHunkRecord(defectRecord()));
    expect(view.before).toBe("after code");
    expect(view.diff).toBe(THREE_LINE_REVERSED);
  });

  it("takes a reversed hunk's header from its own diff, so line numbers match what it sees", () => {
    const view = reviewerViewOfHunk(reverseHunkRecord(defectRecord()));
    expect(view.hunkHeader).toBe("@@ -10,4 +10,3 @@ function f(");
  });

  it("treats an explicit orientation of original like an absent one", () => {
    const hunk = defectRecord({ orientation: "original" });
    expect(reviewerViewOfHunk(hunk).before).toBe("before code");
    expect(reviewerViewOfHunk(hunk).hunkHeader).toBe("@@ -10,3 +10,4 @@ function f(");
  });

  it("falls back to the recorded header when a reversed diff somehow has no @@ line", () => {
    const hunk = defectRecord({ orientation: "reversed", diff: " context only" });
    expect(reviewerViewOfHunk(hunk).hunkHeader).toBe("@@ -10,3 +10,4 @@ function f(");
  });
});

describe("reverseHunkJsonl", () => {
  function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "repo-abc123-1",
      dataset_version: 2,
      repo: "owner/repo",
      license: "MIT",
      commit: "abc123",
      parent: "def456",
      file: "src/thing.ts",
      language: "typescript",
      hunk_header: "@@ -10,3 +10,4 @@ function f(",
      before: "before code",
      after: "after code",
      diff: THREE_LINE_DIFF,
      label: {
        defect: true,
        category: "bugfix",
        touches_public_api: null,
        touches_security: null,
        source: "commit-heuristic",
      },
      evidence: { commit_message: "fix: thing", issue_url: null, pr_url: null },
      needs_manual_review: true,
      ...overrides,
    };
  }

  const defectLine = JSON.stringify(wireRecord());
  const benignLine = JSON.stringify(
    wireRecord({
      id: "repo-benign-1",
      label: {
        defect: false,
        category: "refactor",
        touches_public_api: null,
        touches_security: null,
        source: "commit-heuristic",
      },
    }),
  );

  it("reverses defect lines, copies benign ones, and counts both", () => {
    const result = reverseHunkJsonl(`${defectLine}\n${benignLine}\n`);
    const records = result.content
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(records.map((r) => r.id)).toEqual(["repo-abc123-1-rev", "repo-benign-1"]);
    expect(result.reversedCount).toBe(1);
    expect(result.copiedCount).toBe(1);
  });

  it("writes reversed_from, orientation and the reversed diff on a defect line", () => {
    const [record] = reverseHunkJsonl(defectLine)
      .content.split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(record.reversed_from).toBe("repo-abc123-1");
    expect(record.orientation).toBe("reversed");
    expect(record.diff).toBe(THREE_LINE_REVERSED);
    expect(record.before).toBe("before code");
    expect(record.after).toBe("after code");
    expect(record.hunk_header).toBe("@@ -10,3 +10,4 @@ function f(");
    expect(record.label.defect).toBe(true);
  });

  it('adds only orientation "original" to a benign line, changing nothing else', () => {
    const [record] = reverseHunkJsonl(benignLine)
      .content.split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(record).toEqual({ ...JSON.parse(benignLine), orientation: "original" });
  });

  it("preserves fields this code does not know about", () => {
    const withExtra = JSON.stringify(wireRecord({ future_field: "kept" }));
    const [record] = reverseHunkJsonl(withExtra)
      .content.split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(record.future_field).toBe("kept");
  });

  it("ends the output with exactly one trailing newline and one record per input line", () => {
    const result = reverseHunkJsonl(`${defectLine}\n\n${benignLine}\n`);
    expect(result.content.endsWith("\n")).toBe(true);
    expect(result.content.trimEnd().split("\n")).toHaveLength(2);
  });

  it("fails loudly with the line number on a malformed record", () => {
    expect(() => reverseHunkJsonl(`${defectLine}\n{not json\n`)).toThrow(/line 2/);
  });

  it("refuses a dataset that is already reversed", () => {
    const once = reverseHunkJsonl(defectLine).content;
    expect(() => reverseHunkJsonl(once)).toThrow(/already reversed/);
  });
});
