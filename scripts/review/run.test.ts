import { describe, expect, it } from "vitest";
import { parseArgs } from "./run.js";

describe("parseArgs (scripts/review/run.ts)", () => {
  it("throws when neither --diff nor --git is given", () => {
    expect(() => parseArgs([])).toThrow(/--diff.*--git/);
  });

  it("throws when both --diff and --git are given", () => {
    expect(() => parseArgs(["--diff", "a.diff", "--git", "main..HEAD"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("parses --diff", () => {
    const options = parseArgs(["--diff", "a.diff"]);
    expect(options.diffFile).toBe("a.diff");
    expect(options.gitRange).toBeNull();
  });

  it("parses --git into base/head", () => {
    const options = parseArgs(["--git", "main..HEAD"]);
    expect(options.gitRange).toEqual({ base: "main", head: "HEAD" });
    expect(options.diffFile).toBeNull();
  });

  it("throws on a malformed --git value", () => {
    expect(() => parseArgs(["--git", "main"])).toThrow(/--git/);
  });

  it("defaults mode to dry-run", () => {
    expect(parseArgs(["--diff", "a.diff"]).mode).toBe("dry-run");
  });

  it("parses an explicit --mode", () => {
    expect(parseArgs(["--diff", "a.diff", "--mode", "live"]).mode).toBe("live");
    expect(parseArgs(["--diff", "a.diff", "--mode", "replay"]).mode).toBe("replay");
  });

  it("throws on an unknown --mode", () => {
    expect(() => parseArgs(["--diff", "a.diff", "--mode", "bogus"])).toThrow(/--mode/);
  });

  it("parses --config and --out", () => {
    const options = parseArgs(["--diff", "a.diff", "--config", "custom.yml", "--out", "out/"]);
    expect(options.configPath).toBe("custom.yml");
    expect(options.outDir).toBe("out/");
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--diff", "a.diff", "--bogus"])).toThrow(/--bogus/);
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgs(["--diff"])).toThrow(/--diff/);
  });
});
