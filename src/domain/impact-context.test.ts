import { describe, expect, it } from "vitest";
import {
  IMPACT_MAX_CHARS,
  IMPACT_MAX_MATCHES_PER_SYMBOL,
  IMPACT_MAX_SNIPPETS,
  buildImpactSnippets,
  rankImpactMatches,
} from "./impact-context.js";

const HUNK = { file: "src/cart/total.ts", range: { start: 10, end: 14 } };

describe("rankImpactMatches", () => {
  it("drops matches on the hunk's own lines, keeps the rest of the same file", () => {
    const ranked = rankImpactMatches(
      [
        { symbol: "computeTotal", file: "src/cart/total.ts", line: 12 },
        { symbol: "computeTotal", file: "src/cart/total.ts", line: 40 },
      ],
      HUNK,
      ["computeTotal"],
    );
    expect(ranked).toEqual([
      { symbol: "computeTotal", file: "src/cart/total.ts", line: 40, reason: "same-file" },
    ]);
  });

  it("ranks test files first, then callers in other files, then the same file", () => {
    const ranked = rankImpactMatches(
      [
        { symbol: "computeTotal", file: "src/cart/total.ts", line: 80 },
        { symbol: "computeTotal", file: "src/checkout/pay.ts", line: 5 },
        { symbol: "computeTotal", file: "tests/cart/total.test.ts", line: 3 },
        { symbol: "computeTotal", file: "e2e/tests/checkout.spec.js", line: 9 },
      ],
      HUNK,
      ["computeTotal"],
    );
    expect(ranked.map((m) => [m.file, m.reason])).toEqual([
      ["e2e/tests/checkout.spec.js", "test"],
      ["tests/cart/total.test.ts", "test"],
      ["src/checkout/pay.ts", "caller"],
      ["src/cart/total.ts", "same-file"],
    ]);
  });

  it("orders by symbol rank inside a reason, and caps matches per symbol", () => {
    const many = Array.from({ length: IMPACT_MAX_MATCHES_PER_SYMBOL + 5 }, (_, i) => ({
      symbol: "lessSpecific",
      file: `src/use${String(i).padStart(2, "0")}.ts`,
      line: 1,
    }));
    const ranked = rankImpactMatches(
      [...many, { symbol: "mostSpecific", file: "src/zzz.ts", line: 2 }],
      HUNK,
      ["mostSpecific", "lessSpecific"],
    );
    expect(ranked[0]?.symbol).toBe("mostSpecific");
    expect(ranked.filter((m) => m.symbol === "lessSpecific")).toHaveLength(
      IMPACT_MAX_MATCHES_PER_SYMBOL,
    );
  });

  it("ignores matches for symbols it was not asked about", () => {
    expect(
      rankImpactMatches([{ symbol: "other", file: "src/x.ts", line: 1 }], HUNK, ["computeTotal"]),
    ).toEqual([]);
  });
});

function fileOf(count: number, label: string): string[] {
  return Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);
}

describe("buildImpactSnippets", () => {
  it("cuts ±3 lines around each match, clamped to the file", () => {
    const files = new Map([["src/a.ts", fileOf(20, "a")]]);
    const result = buildImpactSnippets(
      [
        { symbol: "foo", file: "src/a.ts", line: 2, reason: "caller" },
        { symbol: "foo", file: "src/a.ts", line: 15, reason: "caller" },
      ],
      files,
    );
    expect(result.snippets).toEqual([
      { file: "src/a.ts", startLine: 1, lines: fileOf(5, "a"), symbols: ["foo"], reason: "caller" },
      {
        file: "src/a.ts",
        startLine: 12,
        lines: fileOf(18, "a").slice(11),
        symbols: ["foo"],
        reason: "caller",
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.chars).toBe(
      result.snippets.reduce((sum, s) => sum + s.lines.join("\n").length, 0),
    );
  });

  it("merges overlapping matches in one file into one snippet", () => {
    const files = new Map([["src/a.ts", fileOf(30, "a")]]);
    const result = buildImpactSnippets(
      [
        { symbol: "foo", file: "src/a.ts", line: 10, reason: "caller" },
        { symbol: "bar", file: "src/a.ts", line: 14, reason: "caller" },
      ],
      files,
    );
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.startLine).toBe(7);
    expect(result.snippets[0]?.lines).toHaveLength(11);
    expect(result.snippets[0]?.symbols).toEqual(["foo", "bar"]);
  });

  it("skips matches in files it could not read", () => {
    const result = buildImpactSnippets(
      [{ symbol: "foo", file: "gone.ts", line: 1, reason: "caller" }],
      new Map(),
    );
    expect(result.snippets).toEqual([]);
  });

  it("caps the number of snippets", () => {
    const ranked = Array.from({ length: IMPACT_MAX_SNIPPETS + 10 }, (_, i) => ({
      symbol: "foo",
      file: `src/f${i}.ts`,
      line: 1,
      reason: "caller" as const,
    }));
    const files = new Map(ranked.map((m) => [m.file, ["foo();"]]));
    const result = buildImpactSnippets(ranked, files);
    expect(result.snippets).toHaveLength(IMPACT_MAX_SNIPPETS);
    expect(result.truncated).toBe(true);
  });

  it("stops adding snippets at the char cap, in rank order", () => {
    const wide = "w".repeat(1000);
    const ranked = Array.from({ length: 20 }, (_, i) => ({
      symbol: "foo",
      file: `src/f${i}.ts`,
      line: 4,
      reason: "caller" as const,
    }));
    const files = new Map(ranked.map((m) => [m.file, Array.from({ length: 7 }, () => wide)]));
    const result = buildImpactSnippets(ranked, files, { maxChars: 15_000 });
    expect(result.chars).toBeLessThanOrEqual(15_000);
    expect(result.snippets[0]?.file).toBe("src/f0.ts");
    expect(result.truncated).toBe(true);
    expect(IMPACT_MAX_CHARS).toBeGreaterThan(0);
  });
});
