import { describe, expect, it } from "vitest";
import {
  type GoldenCase,
  GoldenSetError,
  parseGoldenSetJsonl,
  stringifyGoldenCase,
} from "./golden-set.js";

const CASE: GoldenCase = {
  schema: 1,
  id: "case-1",
  repoPath: "/tmp/repo",
  baseRef: "aaa",
  headRef: "bbb",
  title: "Add a cart total",
  description: "Sums the cart",
  issues: [
    {
      id: "I1",
      file: "src/cart.ts",
      line: 12,
      lineEnd: 14,
      title: "Total ignores the discount",
      severity: "high",
      verdict: "real",
      category: "defect",
      notes: "cart.ts:12 adds prices before the discount",
    },
    {
      id: "I2",
      file: null,
      line: null,
      title: "Unused import",
      severity: "low",
      verdict: "false",
    },
  ],
};

describe("parseGoldenSetJsonl", () => {
  it("round-trips a case through JSON Lines", () => {
    const text = `${stringifyGoldenCase(CASE)}\n\n${stringifyGoldenCase({ ...CASE, id: "case-2" })}\n`;
    const cases = parseGoldenSetJsonl(text);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual(CASE);
    expect(cases[1]?.id).toBe("case-2");
  });

  it("accepts extra locations on an issue", () => {
    const withLocations = {
      ...CASE,
      issues: [{ ...CASE.issues[0], locations: [{ file: "src/b.ts", line: 3 }] }],
    };
    const [parsed] = parseGoldenSetJsonl(JSON.stringify(withLocations));
    expect(parsed?.issues[0]?.locations).toEqual([{ file: "src/b.ts", line: 3 }]);
  });

  it("rejects an unknown schema version, naming the line", () => {
    expect(() => parseGoldenSetJsonl(JSON.stringify({ ...CASE, schema: 2 }))).toThrow(
      /line 1[\s\S]*schema/,
    );
  });

  it("rejects an invalid verdict or severity", () => {
    const bad = { ...CASE, issues: [{ ...CASE.issues[0], verdict: "maybe" }] };
    expect(() => parseGoldenSetJsonl(JSON.stringify(bad))).toThrow(GoldenSetError);
    const bad2 = { ...CASE, issues: [{ ...CASE.issues[0], severity: "nit" }] };
    expect(() => parseGoldenSetJsonl(JSON.stringify(bad2))).toThrow(GoldenSetError);
  });

  it("rejects duplicate case ids and duplicate issue ids within a case", () => {
    const line = stringifyGoldenCase(CASE);
    expect(() => parseGoldenSetJsonl(`${line}\n${line}`)).toThrow(/duplicate case id/);
    const dupIssues = { ...CASE, issues: [CASE.issues[0], CASE.issues[0]] };
    expect(() => parseGoldenSetJsonl(JSON.stringify(dupIssues))).toThrow(/duplicate issue id/);
  });

  it("rejects invalid JSON with the line number", () => {
    expect(() => parseGoldenSetJsonl(`${stringifyGoldenCase(CASE)}\n{nope`)).toThrow(/line 2/);
  });
});
