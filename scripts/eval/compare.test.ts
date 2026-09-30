import { describe, expect, it } from "vitest";
import { parseCompareArgs } from "./compare.js";

describe("parseCompareArgs (scripts/eval/compare.ts)", () => {
  it("takes run directories and an optional --out", () => {
    expect(parseCompareArgs(["runs/a", "runs/b", "--out", "cmp.md"])).toEqual({
      runs: ["runs/a", "runs/b"],
      outPath: "cmp.md",
    });
    expect(parseCompareArgs(["runs/a"]).outPath).toBeNull();
  });

  it("needs at least one run", () => {
    expect(() => parseCompareArgs([])).toThrow(/at least one/);
  });
});
