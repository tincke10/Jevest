import { describe, expect, it } from "vitest";
import { computeFixChangedLines, labelFinding } from "./line-overlap.js";

describe("computeFixChangedLines", () => {
  it("marks removed/modified lines by their absolute before-side line number", () => {
    // before file lines 10..14: ctx, old1, old2, ctx2 (hunk covers 10-13, 4 lines)
    const diff = ["@@ -10,4 +10,4 @@", " ctx", "-old1", "-old2", "+new1", "+new2", " ctx2"].join(
      "\n",
    );
    const lines = computeFixChangedLines(diff, "@@ -10,4 +10,4 @@");
    expect([...lines].sort((a, b) => a - b)).toEqual([11, 12]);
  });

  it("for a pure addition, marks the line immediately before the insertion point", () => {
    // before file lines 5..7: line5, line6, line7 (nothing removed)
    const diff = ["@@ -5,3 +5,4 @@", " line5", " line6", "+newline", " line7"].join("\n");
    const lines = computeFixChangedLines(diff, "@@ -5,3 +5,4 @@");
    expect([...lines]).toEqual([6]);
  });

  it("marks only one line for a run of several consecutive pure-addition lines", () => {
    const diff = ["@@ -5,2 +5,4 @@", " line5", "+a", "+b", "+c", " line6"].join("\n");
    const lines = computeFixChangedLines(diff, "@@ -5,2 +5,4 @@");
    expect([...lines]).toEqual([5]);
  });

  it("handles a pure deletion (removed lines with no matching additions)", () => {
    const diff = ["@@ -20,3 +20,1 @@", " ctx", "-gone1", "-gone2"].join("\n");
    const lines = computeFixChangedLines(diff, "@@ -20,3 +20,1 @@");
    expect([...lines].sort((a, b) => a - b)).toEqual([21, 22]);
  });

  it("handles multi-segment diffs (more than one @@ header) by resetting the counter per segment", () => {
    const diff = [
      "@@ -10,2 +10,2 @@",
      " ctx",
      "-old",
      "+new",
      "@@ -50,2 +50,3 @@",
      " ctx2",
      "+added",
      " ctx3",
    ].join("\n");
    const lines = computeFixChangedLines(diff, "@@ -10,2 +10,2 @@");
    expect([...lines].sort((a, b) => a - b)).toEqual([11, 50]);
  });

  it("ignores '\\ No newline at end of file' marker lines", () => {
    const diff = ["@@ -1,2 +1,2 @@", " ctx", "-old", "+new", "\\ No newline at end of file"].join(
      "\n",
    );
    const lines = computeFixChangedLines(diff, "@@ -1,2 +1,2 @@");
    expect([...lines]).toEqual([2]);
  });

  it("falls back to the hunk_header start when the diff body has no @@ line of its own", () => {
    const diff = [" ctx", "-old", "+new"].join("\n");
    const lines = computeFixChangedLines(diff, "@@ -30,2 +30,2 @@");
    expect([...lines]).toEqual([31]);
  });
});

describe("labelFinding", () => {
  const fixChangedLines = new Set([11, 12, 51]);

  it("is real when the hunk is a defect and the finding's range overlaps a changed line", () => {
    const label = labelFinding({ lineStart: 11, lineEnd: 11 }, fixChangedLines, true);
    expect(label).toEqual({
      real: true,
      source: "line-overlap",
      overlapLines: 1,
      fixChangedLines: 3,
    });
  });

  it("counts every changed line inside a multi-line range", () => {
    const label = labelFinding({ lineStart: 10, lineEnd: 12 }, fixChangedLines, true);
    expect(label.overlapLines).toBe(2);
    expect(label.real).toBe(true);
  });

  it("is noise when the hunk is a defect but the finding does not overlap any changed line", () => {
    const label = labelFinding({ lineStart: 100, lineEnd: 105 }, fixChangedLines, true);
    expect(label).toEqual({
      real: false,
      source: "line-overlap",
      overlapLines: 0,
      fixChangedLines: 3,
    });
  });

  it("is always noise when the hunk is benign, even with full overlap", () => {
    const label = labelFinding({ lineStart: 11, lineEnd: 12 }, fixChangedLines, false);
    expect(label.real).toBe(false);
    expect(label.overlapLines).toBe(2);
  });
});
