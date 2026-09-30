import { describe, expect, it } from "vitest";
import type { CandidateFinding } from "./candidate.js";
import { type CaseRun, EVAL_RESULTS_SCHEMA_VERSION, runEval } from "./eval-run.js";
import type { GoldenCase } from "./golden-set.js";
import { createTopPrefilterMatcher } from "./match-candidates.js";

function goldenCase(id: string): GoldenCase {
  return {
    schema: 1,
    id,
    repoPath: "/repo",
    baseRef: "a",
    headRef: "b",
    title: `Case ${id}`,
    description: "",
    issues: [
      {
        id: "I1",
        file: "src/a.ts",
        line: 10,
        title: "Null deref",
        severity: "high",
        verdict: "real",
      },
      {
        id: "I2",
        file: "src/b.ts",
        line: 5,
        title: "Bad name",
        severity: "low",
        verdict: "false",
      },
    ],
  };
}

function candidate(caseId: string, n: number, file: string, line: number): CandidateFinding {
  return {
    id: `${caseId}:import:${n}`,
    file,
    line,
    text: "x",
    bucket: "shown",
    source: "import",
  };
}

describe("runEval", () => {
  it("runs every case through the source, matches and scores it", async () => {
    const source = async (c: GoldenCase): Promise<CaseRun> => ({
      caseId: c.id,
      candidates: [candidate(c.id, 0, "src/a.ts", 11), candidate(c.id, 1, "src/zzz.ts", 1)],
      costUsd: 0.25,
      tokens: 100,
      wallTimeMs: 10,
      error: null,
    });
    const results = await runEval({
      variant: "baseline",
      setPath: "/sets/golden.jsonl",
      cases: [goldenCase("c1"), goldenCase("c2")],
      source,
      sourceInfo: { type: "import", dir: "/in" },
      matcher: createTopPrefilterMatcher(),
      matcherInfo: { type: "prefilter" },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(results.schema).toBe(EVAL_RESULTS_SCHEMA_VERSION);
    expect(results.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(results.cases.map((c) => c.candidates.map((m) => m.issueId))).toEqual([
      ["I1", null],
      ["I1", null],
    ]);
    expect(results.totals.shown.recall).toBe(1);
    expect(results.totals.shown.unlabeled).toBe(2);
    expect(results.totals.costUsd).toBeCloseTo(0.5);
    expect(results.matcher).toMatchObject({ type: "prefilter", calls: 2, cacheHits: 0 });
    expect(results.weights.severity.critical).toBe(4);
  });

  it("records a failing case with its error and no candidates instead of aborting", async () => {
    const results = await runEval({
      variant: "v",
      setPath: "s",
      cases: [goldenCase("c1")],
      source: async () => {
        throw new Error("git exploded");
      },
      sourceInfo: {},
      matcher: createTopPrefilterMatcher(),
      matcherInfo: { type: "prefilter" },
    });
    expect(results.cases[0]?.error).toBe("git exploded");
    expect(results.cases[0]?.metrics.shown.targets).toBe(1);
    expect(results.totals.shown.recall).toBe(0);
  });
});
