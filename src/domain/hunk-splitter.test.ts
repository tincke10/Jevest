import { describe, expect, it } from "vitest";
import { mapBeforeLineToAfterLine, splitFileIntoHunks } from "./hunk-splitter.js";

describe("splitFileIntoHunks", () => {
  it("returns an empty array when patch is undefined (binary or omitted file)", () => {
    expect(splitFileIntoHunks("src/thing.ts", undefined)).toEqual([]);
  });

  it("returns an empty array for an empty patch", () => {
    expect(splitFileIntoHunks("src/thing.ts", "")).toEqual([]);
  });

  it("parses a single hunk with context, removed, and added lines", () => {
    const patch = [
      "@@ -1,4 +1,4 @@",
      " line one",
      "-line two old",
      "+line two new",
      " line three",
    ].join("\n");

    const hunks = splitFileIntoHunks("src/thing.ts", patch);
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk!.file).toBe("src/thing.ts");
    expect(hunk!.hunkHeader).toBe("@@ -1,4 +1,4 @@");
    expect(hunk!.oldStart).toBe(1);
    expect(hunk!.newStart).toBe(1);
    expect(hunk!.before).toBe("line one\nline two old\nline three");
    expect(hunk!.after).toBe("line one\nline two new\nline three");
    expect(hunk!.diff).toBe(patch);
  });

  it("parses multiple hunks in the same file patch", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-a", "+A", " b", "@@ -10,2 +10,2 @@", "-c", "+C", " d"].join(
      "\n",
    );

    const hunks = splitFileIntoHunks("src/thing.ts", patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.hunkHeader).toBe("@@ -1,2 +1,2 @@");
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[0]!.before).toBe("a\nb");
    expect(hunks[0]!.after).toBe("A\nb");
    expect(hunks[1]!.hunkHeader).toBe("@@ -10,2 +10,2 @@");
    expect(hunks[1]!.oldStart).toBe(10);
    expect(hunks[1]!.before).toBe("c\nd");
    expect(hunks[1]!.after).toBe("C\nd");
  });

  it("keeps the trailing function-context text on the hunk header", () => {
    const patch = ["@@ -5,3 +5,4 @@ function foo() {", " a", "+b", " c"].join("\n");
    const hunks = splitFileIntoHunks("src/thing.ts", patch);
    expect(hunks[0]!.hunkHeader).toBe("@@ -5,3 +5,4 @@ function foo() {");
  });

  it("handles an added file (all + lines, before is empty)", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+first line", "+second line"].join("\n");
    const hunks = splitFileIntoHunks("src/new.ts", patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toBe("");
    expect(hunks[0]!.after).toBe("first line\nsecond line");
  });

  it("handles a removed file (all - lines, after is empty)", () => {
    const patch = ["@@ -1,2 +0,0 @@", "-first line", "-second line"].join("\n");
    const hunks = splitFileIntoHunks("src/gone.ts", patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toBe("first line\nsecond line");
    expect(hunks[0]!.after).toBe("");
  });

  it("tolerates a '\\ No newline at end of file' marker without adding it to before/after", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const hunks = splitFileIntoHunks("src/thing.ts", patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toBe("old");
    expect(hunks[0]!.after).toBe("new");
    expect(hunks[0]!.diff).toBe(patch);
  });

  it("parses old/new start correctly when the count is omitted (single-line hunk)", () => {
    const patch = ["@@ -5 +5 @@", "-x", "+y"].join("\n");
    const hunks = splitFileIntoHunks("src/thing.ts", patch);
    expect(hunks[0]!.oldStart).toBe(5);
    expect(hunks[0]!.newStart).toBe(5);
  });
});

describe("mapBeforeLineToAfterLine", () => {
  // ReviewFindingCandidate.lineStart/lineEnd are absolute BEFORE-side lines
  // (per reviewer-port.ts), but InlineComment.line must be an absolute
  // HEAD-side (after) line (per vcs-port.ts) — this maps one to the other
  // using the hunk's own diff.

  it("maps an unchanged context line straight across when before and after are aligned", () => {
    const hunk = {
      oldStart: 1,
      newStart: 1,
      diff: ["@@ -1,3 +1,3 @@", " line one", "-line two old", "+line two new", " line three"].join(
        "\n",
      ),
    };
    // "line one" is before-line 1, after-line 1.
    expect(mapBeforeLineToAfterLine(hunk, 1)).toBe(1);
    // "line three" is before-line 3, after-line 3 (one removed + one added line balance out).
    expect(mapBeforeLineToAfterLine(hunk, 3)).toBe(3);
  });

  it("shifts context lines after an insertion", () => {
    const hunk = {
      oldStart: 10,
      newStart: 10,
      diff: ["@@ -10,2 +10,3 @@", " a", "+inserted", " b"].join("\n"),
    };
    // before-line 10 is "a" -> still after-line 10.
    expect(mapBeforeLineToAfterLine(hunk, 10)).toBe(10);
    // before-line 11 is "b" -> shifted to after-line 12 by the inserted line.
    expect(mapBeforeLineToAfterLine(hunk, 11)).toBe(12);
  });

  it("shifts context lines before a deletion back", () => {
    const hunk = {
      oldStart: 10,
      newStart: 10,
      diff: ["@@ -10,3 +10,2 @@", " a", "-removed", " b"].join("\n"),
    };
    expect(mapBeforeLineToAfterLine(hunk, 10)).toBe(10);
    // before-line 12 is "b" -> after-line 11 (one line removed ahead of it).
    expect(mapBeforeLineToAfterLine(hunk, 12)).toBe(11);
  });

  it("anchors a removed (before-only) line at the after-side gap where it used to be", () => {
    const hunk = {
      oldStart: 10,
      newStart: 10,
      diff: ["@@ -10,3 +10,2 @@", " a", "-removed", " b"].join("\n"),
    };
    // before-line 11 ("removed") has no after counterpart; anchors at the
    // after-line position immediately following it (where "b" now sits: 11).
    expect(mapBeforeLineToAfterLine(hunk, 11)).toBe(11);
  });

  it("falls back to newStart when the before-line is outside the hunk", () => {
    const hunk = {
      oldStart: 10,
      newStart: 10,
      diff: ["@@ -10,1 +10,1 @@", "-x", "+y"].join("\n"),
    };
    expect(mapBeforeLineToAfterLine(hunk, 999)).toBe(10);
  });
});
