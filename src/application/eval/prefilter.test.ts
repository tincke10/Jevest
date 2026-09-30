import { describe, expect, it } from "vitest";
import type { GoldenIssue } from "./golden-set.js";
import { prefilterIssues, sameFile, titleCoverage } from "./prefilter.js";

function issue(overrides: Partial<GoldenIssue> & { id: string }): GoldenIssue {
  return {
    file: "src/cart.ts",
    line: 10,
    title: "Total ignores the discount",
    severity: "medium",
    verdict: "real",
    ...overrides,
  };
}

describe("sameFile", () => {
  it("matches equal paths, a path suffix, and equal base names", () => {
    expect(sameFile("src/cart.ts", "src/cart.ts")).toBe(true);
    expect(sameFile("app/src/cart.ts", "src/cart.ts")).toBe(true);
    expect(sameFile("cart.ts", "lib/cart.ts")).toBe(true);
    expect(sameFile("src/cart.ts", "src/carts.ts")).toBe(false);
  });
});

describe("titleCoverage", () => {
  it("is the share of the issue title's words present in the candidate text", () => {
    expect(titleCoverage("Total ignores the discount", "the total ignores any discount")).toBe(1);
    expect(titleCoverage("Total ignores the discount", "rounding error in tax")).toBe(0);
    expect(titleCoverage("cartTotal ignores discount", "cart total")).toBeCloseTo(2 / 4);
  });
});

describe("prefilterIssues", () => {
  const issues = [
    issue({ id: "near", line: 20 }),
    issue({ id: "far", line: 200, title: "Logs the session id" }),
    issue({ id: "other-file", file: "src/tax.ts", line: 10, title: "Rounds tax twice" }),
    issue({ id: "nowhere", file: null, line: null, title: "Discount applied after tax" }),
  ];

  it("keeps same-file issues within ±15 lines", () => {
    const kept = prefilterIssues(issues, { file: "src/cart.ts", line: 30, text: "x" });
    expect(kept.map((i) => i.id)).toEqual(["near"]);
  });

  it("keeps a same-file issue far away when the titles overlap enough", () => {
    const kept = prefilterIssues(issues, {
      file: "src/cart.ts",
      line: 120,
      text: "The session id gets logged in plain text",
    });
    expect(kept.map((i) => i.id)).toEqual(["far"]);
  });

  it("uses an issue's extra locations", () => {
    const withLocation = issue({
      id: "multi",
      file: "tests/cart.test.ts",
      line: 5,
      locations: [{ file: "src/cart.ts", line: 400 }],
    });
    const kept = prefilterIssues([withLocation], { file: "src/cart.ts", line: 405, text: "x" });
    expect(kept.map((i) => i.id)).toEqual(["multi"]);
  });

  it("matches an issue without a location, or a candidate without a file, by title only", () => {
    const kept = prefilterIssues(issues, {
      file: null,
      line: null,
      text: "The discount is applied after tax, so totals are off",
    });
    expect(kept.map((i) => i.id)).toContain("nowhere");
    expect(kept.map((i) => i.id)).toContain("near");
    expect(kept.map((i) => i.id)).not.toContain("other-file");
  });

  it("keeps a cross-file issue only when the titles overlap strongly", () => {
    const kept = prefilterIssues(issues, {
      file: "src/checkout.ts",
      line: 3,
      text: "Tax is rounded twice here",
    });
    expect(kept.map((i) => i.id)).toEqual(["other-file"]);
  });

  it("ranks the closest issue first and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => issue({ id: `i${i}`, line: 10 + i }));
    const kept = prefilterIssues(many, { file: "src/cart.ts", line: 15, text: "x" }, 4);
    expect(kept).toHaveLength(4);
    expect(kept[0]?.id).toBe("i5");
  });
});
