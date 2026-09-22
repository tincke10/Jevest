import { describe, expect, it } from "vitest";
import { parseArgs } from "./reverse-hunks.js";

describe("parseArgs", () => {
  it("defaults to datasets/hunks.jsonl -> datasets/hunks-reversed.jsonl", () => {
    const options = parseArgs([]);
    expect(options.hunksPath).toMatch(/datasets\/hunks\.jsonl$/);
    expect(options.outPath).toMatch(/datasets\/hunks-reversed\.jsonl$/);
  });

  it("parses --hunks and --out", () => {
    const options = parseArgs(["--hunks", "/tmp/in.jsonl", "--out", "/tmp/out.jsonl"]);
    expect(options.hunksPath).toBe("/tmp/in.jsonl");
    expect(options.outPath).toBe("/tmp/out.jsonl");
  });

  it("throws on an unknown flag and on a flag given no value", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/--bogus/);
    expect(() => parseArgs(["--out"])).toThrow(/--out/);
  });
});
