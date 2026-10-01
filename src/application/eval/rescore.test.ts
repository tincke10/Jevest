import { describe, expect, it, vi } from "vitest";
import { createFakeFindingMatcher } from "../../adapters/matchers/fake-finding-matcher.js";
import type { FindingMatchInput } from "../../domain/ports/finding-matcher-port.js";
import type { CandidateFinding } from "./candidate.js";
import { type CaseRun, type EvalResults, runEval } from "./eval-run.js";
import type { GoldenCase, GoldenIssue } from "./golden-set.js";
import { RescoreError, rescoreRun } from "./rescore.js";

const NULL_DEREF: GoldenIssue = {
  id: "I1",
  file: "src/a.ts",
  line: 10,
  title: "Null deref",
  severity: "high",
  verdict: "real",
};

function goldenCase(id: string, issues: readonly GoldenIssue[]): GoldenCase {
  return {
    schema: 1,
    id,
    repoPath: "/repo",
    baseRef: "a",
    headRef: "b",
    title: `Case ${id}`,
    description: "",
    issues,
  };
}

function candidate(caseId: string, n: number, file: string, line: number): CandidateFinding {
  return {
    id: `${caseId}:finding:${n}`,
    file,
    line,
    text: `claim ${n}`,
    claim: `claim ${n}`,
    failingScenario: `scenario ${n}`,
    bucket: "shown",
    source: "finding",
  };
}

/** A stored run: c1 found I1 and showed one finding in src/b.ts; c2 failed closed. */
async function storedRun(): Promise<EvalResults> {
  const runs: Record<string, CaseRun> = {
    c1: {
      caseId: "c1",
      candidates: [candidate("c1", 0, "src/a.ts", 11), candidate("c1", 1, "src/b.ts", 40)],
      costUsd: 0.5,
      tokens: 1000,
      wallTimeMs: 60_000,
      error: null,
    },
    c2: {
      caseId: "c2",
      candidates: [],
      costUsd: 0.1,
      tokens: 10,
      wallTimeMs: 5_000,
      error: 'failed closed at stage "review"',
    },
  };
  return runEval({
    variant: "agentic",
    setPath: "/sets/old.jsonl",
    cases: [goldenCase("c1", [NULL_DEREF]), goldenCase("c2", [NULL_DEREF])],
    source: async (c) => runs[c.id] as CaseRun,
    sourceInfo: { type: "pipeline", mode: "live" },
    matcher: createFakeFindingMatcher((input) => input.goldenIssues[0]?.id ?? null),
    matcherInfo: { type: "fake" },
    concurrency: 2,
    clock: (() => {
      let t = 0;
      return () => {
        t += 1000;
        return t;
      };
    })(),
  });
}

const NEW_ISSUE: GoldenIssue = {
  id: "I9",
  file: "src/b.ts",
  line: 40,
  title: "Leaks the token",
  severity: "critical",
  verdict: "real",
};

describe("rescoreRun", () => {
  it("re-matches the stored candidates against the updated set without re-running anything", async () => {
    const previous = await storedRun();
    expect(previous.cases[0]?.candidates[1]?.issueId).toBeNull();
    const decide = vi.fn((input) => (input.candidate.line === 40 ? "I9" : "I1"));
    const results = await rescoreRun({
      previous,
      runPath: "/runs/agentic",
      variant: "agentic",
      setPath: "/sets/new.jsonl",
      cases: [goldenCase("c1", [NULL_DEREF, NEW_ISSUE]), goldenCase("c2", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(decide, 0.01),
      matcherInfo: { type: "fake-v2" },
      now: () => new Date("2026-02-01T00:00:00Z"),
    });
    expect(results.cases[0]?.candidates.map((c) => c.issueId)).toEqual(["I1", "I9"]);
    expect(results.totals.shown.realBySeverity.critical).toEqual({ found: 1, total: 1 });
    expect(results.setPath).toBe("/sets/new.jsonl");
    expect(results.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(results.matcher).toMatchObject({ type: "fake-v2", calls: 2, costUsd: 0.02 });
  });

  it("hands the matcher the stored claim and failing scenario", async () => {
    const previous = await storedRun();
    const decide = vi.fn((_input: FindingMatchInput): string | null => null);
    await rescoreRun({
      previous,
      runPath: "/runs/agentic",
      variant: "agentic",
      setPath: "/s",
      cases: [goldenCase("c1", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(decide),
      matcherInfo: {},
    });
    expect(decide.mock.calls[0]?.[0]?.candidate).toMatchObject({
      claim: "claim 0",
      failingScenario: "scenario 0",
    });
  });

  it("keeps each case's cost, tokens, wall time and error, and the run's total wall time", async () => {
    const previous = await storedRun();
    const results = await rescoreRun({
      previous,
      runPath: "/runs/agentic",
      variant: "agentic",
      setPath: "/s",
      cases: [goldenCase("c1", [NULL_DEREF]), goldenCase("c2", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(() => null),
      matcherInfo: {},
    });
    expect(results.cases.map((c) => [c.metrics.costUsd, c.metrics.tokens, c.error])).toEqual([
      [0.5, 1000, null],
      [0.1, 10, 'failed closed at stage "review"'],
    ]);
    expect(results.totals.costUsd).toBeCloseTo(0.6);
    expect(results.totals.wallTimeMs).toBe(previous.totals.wallTimeMs);
  });

  it("records where the candidates came from, keeping the original source across rescores", async () => {
    const previous = await storedRun();
    const once = await rescoreRun({
      previous,
      runPath: "/runs/agentic",
      variant: "agentic-v2",
      setPath: "/s",
      cases: [goldenCase("c1", [NULL_DEREF]), goldenCase("c2", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(() => null),
      matcherInfo: {},
    });
    expect(once.variant).toBe("agentic-v2");
    expect(once.source).toEqual({
      type: "rescore",
      run: "/runs/agentic",
      runVariant: "agentic",
      runCreatedAt: previous.createdAt,
      original: { type: "pipeline", mode: "live" },
    });
    const twice = await rescoreRun({
      previous: once,
      runPath: "/runs/agentic-v2",
      variant: "agentic-v3",
      setPath: "/s",
      cases: [goldenCase("c1", [NULL_DEREF]), goldenCase("c2", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(() => null),
      matcherInfo: {},
    });
    expect(twice.source.original).toEqual({ type: "pipeline", mode: "live" });
  });

  it("scores only the cases both the run and the set have, and says which were skipped", async () => {
    const previous = await storedRun();
    const log: string[] = [];
    const results = await rescoreRun({
      previous,
      runPath: "/runs/agentic",
      variant: "agentic",
      setPath: "/s",
      cases: [goldenCase("c1", [NULL_DEREF]), goldenCase("c3", [NULL_DEREF])],
      matcher: createFakeFindingMatcher(() => null),
      matcherInfo: {},
      log: (line) => log.push(line),
    });
    expect(results.cases.map((c) => c.caseId)).toEqual(["c1"]);
    expect(results.totals.wallTimeMs).toBe(60_000);
    expect(log.join("\n")).toMatch(/c3: not in the run/);
    expect(log.join("\n")).toMatch(/c2: not in the set/);
  });

  it("refuses a set that shares no case with the run", async () => {
    const previous = await storedRun();
    await expect(
      rescoreRun({
        previous,
        runPath: "/runs/agentic",
        variant: "agentic",
        setPath: "/s",
        cases: [goldenCase("zz", [NULL_DEREF])],
        matcher: createFakeFindingMatcher(() => null),
        matcherInfo: {},
      }),
    ).rejects.toBeInstanceOf(RescoreError);
  });
});
