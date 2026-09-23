import { describe, expect, it } from "vitest";
import type { CoherencePair } from "../../src/application/coherence/pr-record.js";
import { describePairsStrategy, parseArgs } from "./run.js";

describe("parseArgs", () => {
  it("defaults --pairs to null (caller falls back to datasets/coherence-pairs.jsonl)", () => {
    const options = parseArgs([]);
    expect(options.pairsPath).toBeNull();
  });

  it("parses --pairs", () => {
    const options = parseArgs(["--pairs", "datasets/coherence-pairs-hard.jsonl"]);
    expect(options.pairsPath).toBe("datasets/coherence-pairs-hard.jsonl");
  });

  it("parses --pairs alongside the existing flags", () => {
    const options = parseArgs([
      "--pairs",
      "/tmp/pairs.jsonl",
      "--variant",
      "with-summary",
      "--mode",
      "replay",
      "--limit",
      "10",
      "--seed",
      "7",
    ]);
    expect(options).toEqual({
      variant: "with-summary",
      limit: 10,
      mode: "replay",
      seed: 7,
      pairsPath: "/tmp/pairs.jsonl",
    });
  });

  it("throws when --pairs is given no value", () => {
    expect(() => parseArgs(["--pairs"])).toThrow(/--pairs/);
  });
});

function pair(overrides: Partial<CoherencePair> = {}): CoherencePair {
  return { prId: "x#1", descriptionPrId: "x#2", label: "incoherent", ...overrides };
}

describe("describePairsStrategy", () => {
  it('reports "random (no crossing metadata)" when no pair carries crossing', () => {
    expect(
      describePairsStrategy([pair(), pair({ label: "coherent", descriptionPrId: "x#1" })]),
    ).toBe("random (no crossing metadata)");
  });

  it("reports the single strategy when every crossing pair agrees", () => {
    const pairs = [
      pair({ crossing: { strategy: "hard", similarity: 0.5, donorPr: "x#2" } }),
      pair({ crossing: { strategy: "hard", similarity: 0.8, donorPr: "x#3" } }),
    ];
    expect(describePairsStrategy(pairs)).toBe("hard");
  });

  it("reports a mixed summary when strategies disagree", () => {
    const pairs = [
      pair({ crossing: { strategy: "hard", similarity: 0.5, donorPr: "x#2" } }),
      pair({ crossing: { strategy: "random", similarity: 0, donorPr: "x#3" } }),
    ];
    expect(describePairsStrategy(pairs)).toBe("mixed (hard, random)");
  });
});
