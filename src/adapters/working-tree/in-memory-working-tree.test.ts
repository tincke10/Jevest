import { describe, expect, it } from "vitest";
import { createInMemoryWorkingTree } from "./in-memory-working-tree.js";

describe("createInMemoryWorkingTree", () => {
  const tree = createInMemoryWorkingTree({
    "src/b.ts":
      "import { computeTotal } from './a';\nconst x = computeTotal(1);\nconst computeTotalish = 2;",
    "src/a.ts": "export function computeTotal(n) {\n  return n;\n}",
  });

  it("reads files and returns null for missing ones", async () => {
    expect(await tree.readFile("src/a.ts")).toContain("computeTotal");
    expect(await tree.readFile("src/missing.ts")).toBeNull();
  });

  it("normalizes ./ and rejects paths escaping the tree", async () => {
    expect(await tree.readFile("./src/a.ts")).toContain("computeTotal");
    expect(await tree.readFile("../etc/passwd")).toBeNull();
  });

  it("finds whole-word occurrences ordered by path then line", async () => {
    const matches = await tree.searchSymbols(["computeTotal"]);
    expect(matches).toEqual([
      { symbol: "computeTotal", file: "src/a.ts", line: 1 },
      { symbol: "computeTotal", file: "src/b.ts", line: 1 },
      { symbol: "computeTotal", file: "src/b.ts", line: 2 },
    ]);
  });

  it("caps matches per symbol", async () => {
    const matches = await tree.searchSymbols(["computeTotal"], { maxMatchesPerSymbol: 1 });
    expect(matches).toHaveLength(1);
  });

  it("returns nothing for no symbols", async () => {
    expect(await tree.searchSymbols([])).toEqual([]);
  });
});
