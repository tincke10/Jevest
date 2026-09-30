import { describe, expect, it } from "vitest";
import { buildLabelQueue, renderComparison, renderEvalReport } from "./eval-report.js";
import { type EvalResults, runEval } from "./eval-run.js";
import type { GoldenCase } from "./golden-set.js";
import { createTopPrefilterMatcher } from "./match-candidates.js";

const CASE: GoldenCase = {
  schema: 1,
  id: "c1",
  repoPath: "/repo",
  baseRef: "a",
  headRef: "b",
  title: "Cart totals",
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
    { id: "I2", file: "src/a.ts", line: 40, title: "Bad name", severity: "low", verdict: "false" },
  ],
};

async function results(variant: string, withNoise: boolean): Promise<EvalResults> {
  return runEval({
    variant,
    setPath: "golden.jsonl",
    cases: [CASE],
    source: async () => ({
      caseId: "c1",
      candidates: [
        {
          id: "c1:finding:0",
          file: "src/a.ts",
          line: 10,
          text: "value may be null",
          bucket: "shown",
          source: "finding",
        },
        ...(withNoise
          ? [
              {
                id: "c1:finding:1",
                file: "src/a.ts",
                line: 41,
                text: "rename this",
                bucket: "shown" as const,
                source: "finding" as const,
              },
            ]
          : []),
        {
          id: "c1:low-confidence:0",
          file: "src/z.ts",
          line: 1,
          text: "Something | odd\nhere",
          severity: "major",
          bucket: "low",
          source: "low-confidence",
        },
      ],
      costUsd: 0.12,
      tokens: 3400,
      wallTimeMs: 61_000,
      error: null,
    }),
    sourceInfo: { type: "import" },
    matcher: createTopPrefilterMatcher(),
    matcherInfo: { type: "prefilter" },
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
}

describe("renderEvalReport", () => {
  it("renders the headline numbers, the per-case table and the unlabeled list", async () => {
    const md = renderEvalReport(await results("baseline", true));
    expect(md).toContain("# Eval: baseline");
    expect(md).toContain("| real high | 1/1 |");
    expect(md).toContain("| known-false shown | 1 |");
    expect(md).toContain("| unverifiable shown | 0 |");
    expect(md).toContain("| c1 |");
    expect(md).toContain("- c1 · I2 · `src/a.ts:41` — rename this");
    expect(md).not.toContain("Something");
    expect(md).toContain("$0.12");
  });
});

describe("renderComparison", () => {
  it("puts variants side by side", async () => {
    const md = renderComparison([await results("a", true), await results("b", false)]);
    expect(md).toContain("| metric | a | b |");
    expect(md).toContain("| known noise shown | 1 | 0 |");
    expect(md).toContain("| real found (high) | 1/1 | 1/1 |");
    expect(md).toContain("| cost USD | $0.12 | $0.12 |");
  });
});

describe("buildLabelQueue", () => {
  it("exports unlabeled candidates in the golden issue shape", async () => {
    const queue = buildLabelQueue(await results("a", false), "all");
    expect(queue).toEqual([
      {
        caseId: "c1",
        id: "c1:low-confidence:0",
        file: "src/z.ts",
        line: 1,
        title: "Something | odd\nhere",
        severity: "high",
        verdict: "unlabeled",
        notes: "variant=a; source=low-confidence; bucket=low; reported severity=major",
      },
    ]);
    expect(buildLabelQueue(await results("a", false), "shown")).toEqual([]);
  });
});

describe("cost display", () => {
  it("shows an unknown cost as a dash rather than $0.00", async () => {
    const base = await results("a", false);
    const unknown = {
      ...base,
      totals: { ...base.totals, costUsd: 0, costKnownForAllCases: false, casesWithCost: 0 },
    };
    expect(renderComparison([unknown])).toContain("| cost USD | — |");
    expect(renderEvalReport(unknown)).toContain("| cost | — |");
  });
});
