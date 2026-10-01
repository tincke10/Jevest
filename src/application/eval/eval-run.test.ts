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

  describe("concurrency", () => {
    const ids = ["c1", "c2", "c3", "c4"];
    const base = {
      variant: "v",
      setPath: "/s.jsonl",
      sourceInfo: {},
      matcher: createTopPrefilterMatcher(),
      matcherInfo: {},
    };

    it("keeps the set's case order whatever the completion order", async () => {
      const delays: Record<string, number> = { c1: 30, c2: 5, c3: 20, c4: 1 };
      const finished: string[] = [];
      const source = async (c: GoldenCase): Promise<CaseRun> => {
        await new Promise((r) => setTimeout(r, delays[c.id]));
        finished.push(c.id);
        return {
          caseId: c.id,
          candidates: [],
          costUsd: 1,
          tokens: 1,
          wallTimeMs: delays[c.id] ?? 0,
          error: null,
        };
      };
      const results = await runEval({
        ...base,
        cases: ids.map(goldenCase),
        source,
        concurrency: 4,
      });
      expect(finished).not.toEqual(ids);
      expect(results.cases.map((c) => c.caseId)).toEqual(ids);
      expect(results.cases.map((c) => c.metrics.wallTimeMs)).toEqual([30, 5, 20, 1]);
    });

    it("never exceeds the concurrency bound", async () => {
      let active = 0;
      let peak = 0;
      const source = async (c: GoldenCase): Promise<CaseRun> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return {
          caseId: c.id,
          candidates: [],
          costUsd: null,
          tokens: null,
          wallTimeMs: 5,
          error: null,
        };
      };
      await runEval({ ...base, cases: ids.map(goldenCase), source, concurrency: 2 });
      expect(peak).toBe(2);
    });

    it("reports real elapsed time as the total wall time when concurrent, the sum when sequential", async () => {
      const source = async (c: GoldenCase): Promise<CaseRun> => ({
        caseId: c.id,
        candidates: [],
        costUsd: null,
        tokens: null,
        wallTimeMs: 100,
        error: null,
      });
      let t = 0;
      const clock = () => {
        const v = t;
        t += 150;
        return v;
      };
      const concurrent = await runEval({
        ...base,
        cases: ids.map(goldenCase),
        source,
        concurrency: 4,
        clock,
      });
      expect(concurrent.totals.wallTimeMs).toBe(150);
      expect(concurrent.cases.every((c) => c.metrics.wallTimeMs === 100)).toBe(true);
      const sequential = await runEval({ ...base, cases: ids.map(goldenCase), source, clock });
      expect(sequential.totals.wallTimeMs).toBe(400);
    });

    it("a failing case does not stop the others", async () => {
      const source = async (c: GoldenCase): Promise<CaseRun> => {
        if (c.id === "c2") throw new Error("boom");
        return {
          caseId: c.id,
          candidates: [],
          costUsd: null,
          tokens: null,
          wallTimeMs: 1,
          error: null,
        };
      };
      const results = await runEval({
        ...base,
        cases: ids.map(goldenCase),
        source,
        concurrency: 3,
      });
      expect(results.cases.map((c) => c.error)).toEqual([null, "boom", null, null]);
    });
  });
});
