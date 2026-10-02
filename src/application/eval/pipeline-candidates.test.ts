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

describe("candidatesFromPipeline — evidence-failed findings (reviewer.hunks.requireEvidence)", () => {
  const rejected = (id: string, claim: string): FilteredFinding => ({
    ...finding(id, "src/e.ts", 50, claim),
    isRealDefectProb: Number.NaN,
    rawIsRealDefectProb: Number.NaN,
    rejectedReason: "evidence not found in code",
  });

  it("puts them in the low bucket with their own source, whichever list they are in", () => {
    const candidates = candidatesFromPipeline(
      {
        findingFilter: {
          published: [finding("f1", "src/a.ts", 10, "Null deref")],
          needsHuman: [rejected("f2", "never shown even if routed here")],
          lowConfidence: [rejected("f3", "invented header claim")],
          discarded: [rejected("f4", "invented import claim")],
        },
        narrative: null,
        hunkProfile: null,
      },
      "case-1",
    );
    const failed = candidates.filter((c) => c.source === "evidence-failed");
    expect(failed.map((c) => [c.text.split(" — ")[0], c.bucket])).toEqual([
      ["never shown even if routed here", "low"],
      ["invented header claim", "low"],
      ["invented import claim", "low"],
    ]);
    expect(candidates.filter((c) => c.bucket === "shown").map((c) => c.source)).toEqual([
      "finding",
    ]);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });
});

describe("candidatesFromPipeline — agentic drops (reviewer.mode: agentic)", () => {
  const dropped = (id: string, claim: string, reason: string): FilteredFinding => ({
    ...finding(id, "src/d.ts", 7, claim),
    rejectedReason: reason,
  });

  it("puts every dropped finding in low with source 'dropped', keeping evidence failures apart", () => {
    const candidates = candidatesFromPipeline(
      {
        findingFilter: {
          published: [finding("p", "src/a.ts", 1, "Real bug")],
          needsHuman: [finding("q", "src/a.ts", 2, "A question")],
          lowConfidence: [
            dropped("l1", "Jev said noMatch", "Jev found the evidence does not support the claim"),
            dropped("l2", "No quote found", "evidence not found in code"),
          ],
          discarded: [
            dropped("d1", "Rate limit theory", "excluded (excluded-claim): rate limiting"),
          ],
        },
        narrative: null,
        hunkProfile: null,
      },
      "case-a",
    );
    expect(candidates.map((c) => [c.source, c.bucket])).toEqual([
      ["finding", "shown"],
      ["question", "shown"],
      ["evidence-failed", "low"],
      ["dropped", "low"],
      ["dropped", "low"],
    ]);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });
});

describe("candidatesFromPipeline — agentic matcher context", () => {
  it("keeps an agentic finding's claim, failing scenario and evidence apart for the matcher", () => {
    const agentic: FilteredFinding = {
      ...finding("a", "src/m.ts", 5, "Command rewrites markers"),
      rationale: "Running fmt twice duplicates the marker block",
      agentic: {
        category: "correctness",
        reportedSeverity: "high",
        confidence: 0.8,
        evidence: [{ file: "src/m.ts", line: 5, quote: "replaceMarkers(text)" }],
        evidenceVerified: 1,
        inlineAnchor: null,
        verifier: null,
        supports: null,
        mechanism: null,
        severity: null,
        route: "published",
      },
    };
    const [candidate] = candidatesFromPipeline(
      {
        findingFilter: { published: [agentic], needsHuman: [], lowConfidence: [], discarded: [] },
        narrative: null,
        hunkProfile: null,
      },
      "c",
    );
    expect(candidate).toMatchObject({
      text: "Command rewrites markers — Running fmt twice duplicates the marker block",
      claim: "Command rewrites markers",
      failingScenario: "Running fmt twice duplicates the marker block",
      evidence: [{ file: "src/m.ts", line: 5, quote: "replaceMarkers(text)" }],
    });
  });

  it("adds nothing to a per-hunk finding", () => {
    const [candidate] = candidatesFromPipeline(
      {
        findingFilter: {
          published: [finding("p", "src/a.ts", 1, "Bug")],
          needsHuman: [],
          lowConfidence: [],
          discarded: [],
        },
        narrative: null,
        hunkProfile: null,
      },
      "c",
    );
    expect(candidate).not.toHaveProperty("claim");
    expect(candidate).not.toHaveProperty("failingScenario");
    expect(candidate).not.toHaveProperty("evidence");
  });
});
