import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LINE_TOLERANCE,
  MAX_EVIDENCE_ITEMS,
  evidencePathCandidates,
  verifyEvidence,
} from "./evidence-verifier.js";

const HUNK = {
  file: "src/cart/total.ts",
  before: "export function total(items) {\n  return items.reduce(sum, 0);\n}",
  diff: [
    "@@ -1,3 +1,3 @@",
    " export function total(items) {",
    "-  return items.reduce(sum, 0);",
    "+  return items.reduce(sumWithTax, 0);",
    " }",
  ].join("\n"),
};

const HEAD_FILE = [
  "export function total(items) {",
  "  return items.reduce(sumWithTax, 0);",
  "}",
  "",
  "export function sumWithTax(acc, item) {",
  "  return acc + item.price * (1 + item.taxRate);",
  "}",
];

const CALLER = Array.from({ length: 40 }, (_, i) => `// caller line ${i + 1}`);
CALLER[19] = "const due = total(cart.items) - cart.discount;";

const HEAD = new Map<string, readonly string[] | null>([
  ["src/cart/total.ts", HEAD_FILE],
  ["src/checkout/pay.ts", CALLER],
]);

describe("verifyEvidence — with a working tree", () => {
  it("verifies a quote found at the cited line of the head file", () => {
    const check = verifyEvidence(
      [
        {
          file: "src/cart/total.ts",
          line: 6,
          quote: "return acc + item.price * (1 + item.taxRate);",
        },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check).toEqual({
      verified: 1,
      checked: 1,
      items: [
        {
          item: {
            file: "src/cart/total.ts",
            line: 6,
            quote: "return acc + item.price * (1 + item.taxRate);",
          },
          match: "head",
        },
      ],
    });
  });

  it(`accepts the quote within ±${EVIDENCE_LINE_TOLERANCE} lines, not further`, () => {
    const near = verifyEvidence(
      [
        {
          file: "src/checkout/pay.ts",
          line: 20 + EVIDENCE_LINE_TOLERANCE,
          quote: "total(cart.items)",
        },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(near.verified).toBe(1);
    const far = verifyEvidence(
      [
        {
          file: "src/checkout/pay.ts",
          line: 20 + EVIDENCE_LINE_TOLERANCE + 1,
          quote: "total(cart.items)",
        },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(far.verified).toBe(0);
    expect(far.items[0]?.match).toBeNull();
  });

  it("normalizes whitespace, diff markers, line-number prefixes and a trailing ellipsis", () => {
    const check = verifyEvidence(
      [
        { file: "src/cart/total.ts", line: 2, quote: "return   items.reduce(sumWithTax,0);" },
        { file: "src/cart/total.ts", line: 2, quote: "+  return items.reduce(sumWithTax, 0);" },
        { file: "src/cart/total.ts", line: 2, quote: "2| return items.reduce(sumWithTax, 0);" },
        { file: "src/cart/total.ts", line: 5, quote: "export function sumWithTax(acc, item) {..." },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check.items.map((i) => i.match)).toEqual(["head", "head", "head"]);
    expect(check.checked).toBe(MAX_EVIDENCE_ITEMS);
  });

  it("matches a multi-line quote", () => {
    const check = verifyEvidence(
      [
        {
          file: "src/cart/total.ts",
          line: 5,
          quote: "export function sumWithTax(acc, item) {\n  return acc + item.price",
        },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check.verified).toBe(1);
  });

  it("verifies quoted removed code against the hunk's before side", () => {
    const check = verifyEvidence(
      [{ file: "src/cart/total.ts", line: 2, quote: "items.reduce(sum, 0)" }],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check.items[0]?.match).toBe("removed");
  });

  it("rejects a quote that is not in the code at all", () => {
    const check = verifyEvidence(
      [{ file: "src/cart/total.ts", line: 2, quote: "import { sum } from './sum';" }],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check.verified).toBe(0);
  });

  it("rejects quotes too short to prove anything, and a missing file", () => {
    const check = verifyEvidence(
      [
        { file: "src/cart/total.ts", line: 3, quote: " } " },
        { file: "src/nowhere.ts", line: 1, quote: "total(cart.items)" },
      ],
      { hunk: HUNK, headFiles: HEAD },
    );
    expect(check.verified).toBe(0);
    expect(check.checked).toBe(2);
  });

  it("accepts ./, / and a/ b/ prefixes on the path", () => {
    for (const file of ["./src/checkout/pay.ts", "/src/checkout/pay.ts", "b/src/checkout/pay.ts"]) {
      expect(
        verifyEvidence([{ file, line: 20, quote: "total(cart.items)" }], {
          hunk: HUNK,
          headFiles: HEAD,
        }).verified,
      ).toBe(1);
    }
    expect(evidencePathCandidates("./b/src/x.ts")).toEqual(["b/src/x.ts", "src/x.ts"]);
  });

  it("returns zero checked for an empty evidence list", () => {
    expect(verifyEvidence([], { hunk: HUNK, headFiles: HEAD })).toEqual({
      verified: 0,
      checked: 0,
      items: [],
    });
  });
});

describe("verifyEvidence — without a working tree (hunk text only)", () => {
  it("verifies a quote from the hunk's added, context or removed lines", () => {
    const check = verifyEvidence(
      [
        { file: "src/cart/total.ts", line: 2, quote: "items.reduce(sumWithTax, 0)" },
        { file: "src/cart/total.ts", line: 1, quote: "export function total(items) {" },
        { file: "src/cart/total.ts", line: 2, quote: "items.reduce(sum, 0)" },
      ],
      { hunk: HUNK, headFiles: null },
    );
    expect(check.items.map((i) => i.match)).toEqual(["hunk", "hunk", "removed"]);
  });

  it("falls back to the hunk text when the hunk's file is not readable in the working tree", () => {
    const check = verifyEvidence(
      [{ file: "src/cart/total.ts", line: 2, quote: "items.reduce(sumWithTax, 0)" }],
      { hunk: HUNK, headFiles: new Map([["src/cart/total.ts", null]]) },
    );
    expect(check.items[0]?.match).toBe("hunk");
  });

  it("cannot verify a quote from another file", () => {
    const check = verifyEvidence(
      [{ file: "src/checkout/pay.ts", line: 20, quote: "total(cart.items)" }],
      { hunk: HUNK, headFiles: null },
    );
    expect(check.verified).toBe(0);
  });
});
