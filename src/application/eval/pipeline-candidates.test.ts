import { describe, expect, it } from "vitest";
import type { FilteredFinding } from "../pipeline/stages/finding-filter.js";
import { candidatesFromPipeline, narrativePoints } from "./pipeline-candidates.js";

function finding(id: string, file: string, line: number, claim: string): FilteredFinding {
  return {
    findingId: id,
    hunkId: `${file}#0`,
    file,
    lineStart: line,
    lineEnd: line + 2,
    claim,
    rationale: "because",
    isRealDefectProb: 0.9,
    rawIsRealDefectProb: 0.9,
    jevSeverityScore: 2,
    isStyleOnlyProb: 0.1,
    actionableProb: 0.9,
    requestId: "r",
    unverified: false,
  };
}

describe("narrativePoints", () => {
  it("extracts bullet points with their file:line reference", () => {
    const markdown = [
      "## Review",
      "",
      "Overall fine.",
      "",
      "- `src/cart.ts:42` — the total ignores the discount.",
      "* `src/tax.ts:7-9`: tax is rounded twice",
      "1. A point without a reference that is long enough",
      "- ok",
      "",
      "**Answer 1 question**",
    ].join("\n");
    expect(narrativePoints(markdown)).toEqual([
      { file: "src/cart.ts", line: 42, text: "`src/cart.ts:42` — the total ignores the discount." },
      { file: "src/tax.ts", line: 7, lineEnd: 9, text: "`src/tax.ts:7-9`: tax is rounded twice" },
      { file: null, line: null, text: "A point without a reference that is long enough" },
    ]);
  });

  it("stops at the details block", () => {
    const markdown = "- `a.ts:1` — first point here\n<details>\n- `b.ts:2` — inside details";
    expect(narrativePoints(markdown)).toHaveLength(1);
  });
});

describe("candidatesFromPipeline", () => {
  it("buckets published, needs-human, narrative and secret as shown; low-confidence and discarded as low", () => {
    const candidates = candidatesFromPipeline(
      {
        findingFilter: {
          published: [finding("f1", "src/a.ts", 10, "Null deref")],
          needsHuman: [finding("f2", "src/b.ts", 20, "Is this async on purpose?")],
          lowConfidence: [finding("f3", "src/c.ts", 30, "Maybe slow")],
          discarded: [finding("f4", "src/d.ts", 40, "Style")],
        },
        narrative: { markdown: "- `src/a.ts:10` — the value can be null here" },
        hunkProfile: {
          hunks: [
            {
              file: "tests/x.test.ts",
              newStart: 5,
              hunkHeader: "@@ -1 +5 @@",
              containsSecret: true,
            },
            { file: "src/y.ts", newStart: 1, hunkHeader: "@@ -1 +1 @@", containsSecret: false },
          ],
        },
      },
      "case-1",
    );
    expect(candidates.map((c) => [c.id, c.bucket, c.source, c.file, c.line])).toEqual([
      ["case-1:finding:0", "shown", "finding", "src/a.ts", 10],
      ["case-1:question:0", "shown", "question", "src/b.ts", 20],
      ["case-1:narrative:0", "shown", "narrative", "src/a.ts", 10],
      ["case-1:secret:0", "shown", "secret", "tests/x.test.ts", 5],
      ["case-1:low-confidence:0", "low", "low-confidence", "src/c.ts", 30],
      ["case-1:discarded:0", "low", "discarded", "src/d.ts", 40],
    ]);
    expect(candidates[0]?.text).toBe("Null deref — because");
    expect(candidates[0]?.lineEnd).toBe(12);
    expect(candidates[3]?.text).toMatch(/possible committed secret/i);
  });

  it("returns nothing for a run that failed before the filter", () => {
    expect(
      candidatesFromPipeline({ findingFilter: null, narrative: null, hunkProfile: null }, "c"),
    ).toEqual([]);
  });
});
