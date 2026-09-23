import { describe, expect, it } from "vitest";
import { parseArgs } from "./generate-pairs.js";

describe("parseArgs", () => {
  it("defaults to datasets/prs.jsonl -> datasets/coherence-pairs.jsonl, seed 42, strategy random", () => {
    const options = parseArgs([]);
    expect(options.prsPath).toMatch(/datasets\/prs\.jsonl$/);
    expect(options.outPath).toMatch(/datasets\/coherence-pairs\.jsonl$/);
    expect(options.seed).toBe(42);
    expect(options.strategy).toBe("random");
  });

  it("parses --prs, --out, --seed and --strategy", () => {
    const options = parseArgs([
      "--prs",
      "/tmp/in.jsonl",
      "--out",
      "/tmp/out.jsonl",
      "--seed",
      "7",
      "--strategy",
      "hard",
    ]);
    expect(options.prsPath).toBe("/tmp/in.jsonl");
    expect(options.outPath).toBe("/tmp/out.jsonl");
    expect(options.seed).toBe(7);
    expect(options.strategy).toBe("hard");
  });

  it("rejects an unknown strategy", () => {
    expect(() => parseArgs(["--strategy", "bogus"])).toThrow(/--strategy/);
  });

  it("throws on an unknown flag and on a flag given no value", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/--bogus/);
    expect(() => parseArgs(["--seed"])).toThrow(/--seed/);
  });
});
