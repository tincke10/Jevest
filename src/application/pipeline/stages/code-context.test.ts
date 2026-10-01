import { describe, expect, it } from "vitest";
import { createInMemoryWorkingTree } from "../../../adapters/working-tree/in-memory-working-tree.js";
import type { WorkingTreePort } from "../../../domain/ports/working-tree-port.js";
import {
  CODE_CONTEXT_UNAVAILABLE_PREFIX,
  createHeadFileReader,
  runCodeContextStage,
} from "./code-context.js";
import type { HunkProfileEntry } from "./hunk-profile.js";

function makeHunk(overrides: Partial<HunkProfileEntry> = {}): HunkProfileEntry {
  return {
    id: "src/cart/total.ts#0",
    file: "src/cart/total.ts",
    hunkHeader: "@@ -1,3 +1,3 @@",
    before: "export function computeTotal(items) {\n  return items.reduce(sum, 0);\n}",
    diff: [
      "@@ -1,3 +1,3 @@",
      " export function computeTotal(items) {",
      "-  return items.reduce(sum, 0);",
      "+  return items.reduce(sumWithTax, 0);",
      " }",
    ].join("\n"),
    oldStart: 1,
    newStart: 1,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.9,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
    containsReviewerInstructionsProb: 0.03,
    touchesPublicApi: false,
    touchesPublicApiPartial: true,
    requestId: "req1",
    latencyMs: 10,
    usage: { inputTokens: 5, outputTokens: 0 },
    skippedFromReview: false,
    containsSecret: false,
    profileFailed: false,
    astSkipped: null,
    ...overrides,
  };
}

const TREE_FILES = {
  "src/cart/total.ts": [
    "export function computeTotal(items) {",
    "  return items.reduce(sumWithTax, 0);",
    "}",
    "",
    "export function sumWithTax(acc, item) {",
    '  const apiKey = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
    "  return acc + item.price;",
    "}",
  ].join("\n"),
  "src/checkout/pay.ts":
    "import { sumWithTax } from '../cart/total';\nconst due = [1].reduce(sumWithTax, 0);\n",
  "tests/cart/total.test.ts":
    "it('adds tax', () => {\n  expect([1].reduce(sumWithTax, 0)).toBe(1);\n});\n",
};

describe("runCodeContextStage", () => {
  it("builds the full file (redacted) and the impact context per eligible hunk", async () => {
    const result = await runCodeContextStage({
      hunks: [makeHunk()],
      workingTree: createInMemoryWorkingTree(TREE_FILES),
      fullFile: true,
      impactContext: true,
    });
    expect(result.unavailable).toBeNull();
    const [hunk] = result.hunks;
    expect(hunk?.hunkId).toBe("src/cart/total.ts#0");
    expect(hunk?.fullFile?.mode).toBe("full");
    const fullText = hunk?.fullFile?.segments.flatMap((s) => s.lines).join("\n") ?? "";
    expect(fullText).toContain("[REDACTED]");
    expect(fullText).not.toContain("sk-ant-api03");
    expect(hunk?.symbols).toEqual(["sumWithTax"]);
    const files = hunk?.impactContext?.snippets.map((s) => [s.file, s.reason]);
    expect(files).toEqual([
      ["tests/cart/total.test.ts", "test"],
      ["src/checkout/pay.ts", "caller"],
      ["src/cart/total.ts", "same-file"],
    ]);
    expect(result.totals).toEqual({
      hunks: 1,
      files: 3,
      snippets: 3,
      fullFileChars: hunk?.fullFile?.chars,
      impactChars: hunk?.impactContext?.chars,
    });
  });

  it("only builds the layers that are on", async () => {
    const onlyImpact = await runCodeContextStage({
      hunks: [makeHunk()],
      workingTree: createInMemoryWorkingTree(TREE_FILES),
      fullFile: false,
      impactContext: true,
    });
    expect(onlyImpact.hunks[0]?.fullFile).toBeNull();
    expect(onlyImpact.hunks[0]?.impactContext).not.toBeNull();
    const onlyFile = await runCodeContextStage({
      hunks: [makeHunk()],
      workingTree: createInMemoryWorkingTree(TREE_FILES),
      fullFile: true,
      impactContext: false,
    });
    expect(onlyFile.hunks[0]?.impactContext).toBeNull();
    expect(onlyFile.hunks[0]?.symbols).toEqual([]);
  });

  it("skips hunks the profile kept from review", async () => {
    const result = await runCodeContextStage({
      hunks: [makeHunk({ skippedFromReview: true })],
      workingTree: createInMemoryWorkingTree(TREE_FILES),
      fullFile: true,
      impactContext: true,
    });
    expect(result.hunks).toEqual([]);
  });

  it("says so in one line and builds nothing without a working tree", async () => {
    const result = await runCodeContextStage({
      hunks: [makeHunk()],
      fullFile: true,
      impactContext: true,
      unavailableReason: "no checkout",
    });
    expect(result.hunks).toEqual([]);
    expect(result.unavailable).toBe(`${CODE_CONTEXT_UNAVAILABLE_PREFIX}: no checkout`);
    expect(result.unavailable).toMatch(/^Impact context unavailable: no checkout/);
  });

  it("records a per-hunk error and continues, never throwing", async () => {
    const broken: WorkingTreePort = {
      readFile: async () => "x",
      searchSymbols: async () => {
        throw new Error("rg exploded");
      },
    };
    const result = await runCodeContextStage({
      hunks: [makeHunk(), makeHunk({ id: "second" })],
      workingTree: broken,
      fullFile: true,
      impactContext: true,
    });
    expect(result.hunks.map((h) => h.error)).toEqual(["rg exploded", "rg exploded"]);
    expect(result.hunks[0]?.fullFile).not.toBeNull();
    expect(result.hunks[0]?.impactContext).toBeNull();
  });

  it("gives a hunk whose file is missing at the head no full file, without an error", async () => {
    const result = await runCodeContextStage({
      hunks: [makeHunk({ file: "src/deleted.ts" })],
      workingTree: createInMemoryWorkingTree(TREE_FILES),
      fullFile: true,
      impactContext: false,
    });
    expect(result.hunks[0]?.fullFile).toBeNull();
    expect(result.hunks[0]?.error).toBeNull();
  });
});

describe("createHeadFileReader", () => {
  it("returns redacted lines, cached per path, null for a missing file", async () => {
    let reads = 0;
    const inner = createInMemoryWorkingTree(TREE_FILES);
    const reader = createHeadFileReader({
      readFile: async (path) => {
        reads++;
        return inner.readFile(path);
      },
      searchSymbols: inner.searchSymbols,
    });
    const lines = await reader("src/cart/total.ts");
    expect(lines?.[5]).toContain("[REDACTED]");
    await reader("src/cart/total.ts");
    expect(reads).toBe(1);
    expect(await reader("nope.ts")).toBeNull();
  });
});
