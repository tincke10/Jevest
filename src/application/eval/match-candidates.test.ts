import { describe, expect, it, vi } from "vitest";
import type {
  FindingMatchInput,
  FindingMatcherPort,
} from "../../domain/ports/finding-matcher-port.js";
import type { CandidateFinding } from "./candidate.js";
import type { GoldenIssue } from "./golden-set.js";
import { createTopPrefilterMatcher, matchCandidates } from "./match-candidates.js";

const ISSUES: GoldenIssue[] = [
  {
    id: "I1",
    file: "src/cart.ts",
    line: 10,
    title: "Total ignores discount",
    severity: "high",
    verdict: "real",
  },
  {
    id: "I2",
    file: "src/cart.ts",
    line: 14,
    title: "Currency symbol hardcoded",
    severity: "low",
    verdict: "false",
  },
];

function candidate(id: string, file: string | null, line: number | null): CandidateFinding {
  return { id, file, line, text: `claim ${id}`, bucket: "shown", source: "import" };
}

describe("matchCandidates", () => {
  it("asks the matcher only among the pre-filtered issues", async () => {
    const seen: FindingMatchInput[] = [];
    const matcher: FindingMatcherPort = {
      async match(input) {
        seen.push(input);
        return { issueId: "I2", costUsd: 0.01 };
      },
    };
    const result = await matchCandidates({
      issues: ISSUES,
      candidates: [candidate("c1", "src/cart.ts", 12)],
      matcher,
    });
    expect(seen[0]?.goldenIssues.map((i) => i.id)).toEqual(["I1", "I2"]);
    expect(seen[0]?.candidate).toEqual({ file: "src/cart.ts", line: 12, text: "claim c1" });
    expect(result.matched[0]?.issueId).toBe("I2");
    expect(result.matcherCalls).toBe(1);
    expect(result.matcherCostUsd).toBeCloseTo(0.01);
  });

  it("never calls the matcher when nothing passes the pre-filter", async () => {
    const match = vi.fn();
    const result = await matchCandidates({
      issues: ISSUES,
      candidates: [candidate("c1", "src/other.ts", 500)],
      matcher: { match },
    });
    expect(match).not.toHaveBeenCalled();
    expect(result.matched[0]?.issueId).toBeNull();
    expect(result.matcherCalls).toBe(0);
  });

  it("treats an id outside the pre-filtered set as no match", async () => {
    const result = await matchCandidates({
      issues: ISSUES,
      candidates: [candidate("c1", "src/cart.ts", 12)],
      matcher: { match: async () => ({ issueId: "I9", costUsd: 0 }) },
    });
    expect(result.matched[0]?.issueId).toBeNull();
  });

  it("counts cache hits and keeps candidate order under concurrency", async () => {
    const result = await matchCandidates({
      issues: ISSUES,
      candidates: [candidate("a", "src/cart.ts", 10), candidate("b", "src/cart.ts", 14)],
      matcher: {
        match: async (input) => ({
          issueId: input.candidate.line === 10 ? "I1" : "I2",
          costUsd: 0,
          cached: input.candidate.line === 10,
        }),
      },
      concurrency: 2,
    });
    expect(result.matched.map((m) => [m.id, m.issueId])).toEqual([
      ["a", "I1"],
      ["b", "I2"],
    ]);
    expect(result.cacheHits).toBe(1);
  });
});

describe("matchCandidates — what the matcher is offered", () => {
  const rich: GoldenIssue[] = [
    {
      id: "R1",
      file: "src/fmt.ts",
      line: 10,
      locations: [{ file: "src/cli.ts", line: 4 }],
      title: "fmt rewrites the marker block",
      severity: "high",
      verdict: "real",
      category: "correctness",
      notes: "Running fmt twice duplicates the block",
    },
    {
      id: "R2",
      file: "src/fmt.ts",
      line: 400,
      title: "Marker regex ignores CRLF",
      severity: "low",
      verdict: "partly",
    },
  ];

  it("offers every same-file issue with its locations, category, verdict and notes", async () => {
    const seen: FindingMatchInput[] = [];
    await matchCandidates({
      issues: rich,
      candidates: [
        {
          id: "c",
          file: "src/fmt.ts",
          line: 12,
          text: "claim — scenario",
          claim: "claim",
          failingScenario: "scenario",
          evidence: [{ file: "src/fmt.ts", line: 12, quote: "q" }],
          bucket: "shown",
          source: "finding",
        },
      ],
      matcher: {
        async match(input) {
          seen.push(input);
          return { issueId: null, costUsd: 0 };
        },
      },
    });
    expect(seen[0]?.goldenIssues).toEqual([
      {
        id: "R1",
        file: "src/fmt.ts",
        line: 10,
        locations: [{ file: "src/cli.ts", line: 4 }],
        title: "fmt rewrites the marker block",
        category: "correctness",
        verdict: "real",
        notes: "Running fmt twice duplicates the block",
      },
      {
        id: "R2",
        file: "src/fmt.ts",
        line: 400,
        title: "Marker regex ignores CRLF",
        verdict: "partly",
      },
    ]);
    expect(seen[0]?.candidate).toEqual({
      file: "src/fmt.ts",
      line: 12,
      text: "claim — scenario",
      claim: "claim",
      failingScenario: "scenario",
      evidence: [{ file: "src/fmt.ts", line: 12, quote: "q" }],
    });
  });
});

describe("createTopPrefilterMatcher", () => {
  it("still picks from the strict pre-filter, not the wider shortlist", async () => {
    const matcher = createTopPrefilterMatcher();
    const match = await matcher.match({
      goldenIssues: [{ id: "far", file: "src/cart.ts", line: 300, title: "Unrelated words" }],
      candidate: { file: "src/cart.ts", line: 11, text: "x" },
    });
    expect(match.issueId).toBeNull();
  });

  it("picks the pre-filter's closest issue", async () => {
    const matcher = createTopPrefilterMatcher();
    const match = await matcher.match({
      goldenIssues: ISSUES,
      candidate: { file: "src/cart.ts", line: 11, text: "x" },
    });
    expect(match).toEqual({ issueId: "I1", costUsd: 0 });
  });
});
