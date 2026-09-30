import { describe, expect, it } from "vitest";
import {
  type AdjudicationFile,
  convertAdjudication,
  extractFileRefs,
  resolveFileRef,
} from "./adjudication-import.js";

const FILES = [
  "src/cart/Cart.ts",
  "src/cart/cart.test.ts",
  "src/tax/TaxService.php",
  "legacy/cart/Cart.ts",
  "docs/README.md",
];
const CHANGED = ["src/cart/Cart.ts", "src/cart/cart.test.ts"];

describe("extractFileRefs", () => {
  it("finds file:line and file:start-end references, including extensionless class names", () => {
    expect(
      extractFileRefs("Cart.ts:42 sums first; cart.test.ts:10-14 misses it; TaxService:7 (:3-5)."),
    ).toEqual([
      { name: "Cart.ts", line: 42 },
      { name: "cart.test.ts", line: 10, lineEnd: 14 },
      { name: "TaxService", line: 7 },
    ]);
  });

  it("ignores scope operators and URLs without a line", () => {
    expect(extractFileRefs("Http::fake() and https://example.com/x")).toEqual([]);
  });
});

describe("resolveFileRef", () => {
  it("resolves by path suffix, base name (preferring changed files) or stem", () => {
    expect(resolveFileRef("cart/cart.test.ts", FILES, CHANGED)).toBe("src/cart/cart.test.ts");
    expect(resolveFileRef("Cart.ts", FILES, CHANGED)).toBe("src/cart/Cart.ts");
    expect(resolveFileRef("TaxService", FILES, CHANGED)).toBe("src/tax/TaxService.php");
    expect(resolveFileRef("Missing.ts", FILES, CHANGED)).toBeNull();
  });

  it("resolves an abbreviated name to the one changed file ending with it", () => {
    expect(resolveFileRef("test.ts", FILES, CHANGED)).toBe("src/cart/cart.test.ts");
    expect(resolveFileRef("ts", FILES, CHANGED)).toBeNull();
    expect(resolveFileRef("md", FILES, CHANGED)).toBeNull();
  });
});

describe("convertAdjudication", () => {
  const v1: AdjudicationFile = {
    issues: [
      {
        id: "I1",
        title: "Total ignores the discount",
        found_by: "local",
        local_kind: "defect",
        verdict: "real",
        severity: "high",
        evidence: "Cart.ts:42 adds prices first; cart.test.ts:10 only covers no discount.",
      },
      {
        id: "I2",
        title: "Rename suggestion",
        found_by: "pipeline",
        verdict: "false",
        severity: null,
        evidence: "Naming is consistent with the module.",
      },
      {
        id: "I3",
        title: "Tax rounding is odd",
        found_by: "pipeline",
        verdict: "partly",
        severity: "nit",
        evidence: "TaxService:7-9 rounds per line.",
      },
    ],
  };
  const v2: AdjudicationFile = {
    new_issues: [
      {
        id: "NEW1",
        title: "Weak assertion in the cart test",
        found_by: "pipeline",
        verdict: "partly",
        severity: "low",
        evidence: "cart.test.ts:20-22.",
      },
    ],
  };

  const goldenCase = convertAdjudication({
    caseId: "case-7",
    v1,
    v2,
    meta: { title: "Cart discount", body: "Applies discounts" },
    repo: {
      repoPath: "/evals/repo",
      baseRef: "base-sha",
      headRef: "head-sha",
      files: FILES,
      changedFiles: CHANGED,
    },
    anchors: [
      { file: "src/cart/Cart.ts", line: 40, text: "The total ignores the discount entirely" },
    ],
  });

  it("builds the case header from the meta and the repo refs", () => {
    expect(goldenCase).toMatchObject({
      schema: 1,
      id: "case-7",
      repoPath: "/evals/repo",
      baseRef: "base-sha",
      headRef: "head-sha",
      title: "Cart discount",
      description: "Applies discounts",
    });
    expect(goldenCase.issues.map((i) => i.id)).toEqual(["I1", "I2", "I3", "NEW1"]);
  });

  it("anchors an issue on a matching review finding and keeps the evidence refs as extra locations", () => {
    expect(goldenCase.issues[0]).toMatchObject({
      file: "src/cart/Cart.ts",
      line: 40,
      locations: [
        { file: "src/cart/Cart.ts", line: 42 },
        { file: "src/cart/cart.test.ts", line: 10 },
      ],
      severity: "high",
      verdict: "real",
      category: "defect",
    });
    expect(goldenCase.issues[0]?.notes).toContain("found_by=local");
    expect(goldenCase.issues[0]?.notes).toContain("Cart.ts:42 adds prices first");
  });

  it("falls back to the first evidence ref, maps severities and keeps unlocated issues", () => {
    expect(goldenCase.issues[1]).toMatchObject({ file: null, line: null, severity: "low" });
    expect(goldenCase.issues[2]).toMatchObject({
      file: "src/tax/TaxService.php",
      line: 7,
      lineEnd: 9,
      severity: "low",
      verdict: "partly",
    });
    expect(goldenCase.issues[3]).toMatchObject({ file: "src/cart/cart.test.ts", line: 20 });
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      convertAdjudication({
        caseId: "x",
        v1: { issues: [{ id: "I1", title: "t", verdict: "maybe", severity: "low" }] },
        meta: { title: "", body: "" },
        repo: { repoPath: "r", baseRef: "a", headRef: "b", files: [], changedFiles: [] },
      }),
    ).toThrow(/verdict/);
  });
});
