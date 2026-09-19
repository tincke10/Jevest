import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, resolveConfig } from "./run.js";

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

describe("resolveConfig (scripts/review/run.ts)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-review-run-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports usedDefault=false when the config file exists", async () => {
    const configPath = join(dir, ".jevest.yml");
    await writeFile(
      configPath,
      "reviewer:\n  provider: anthropic\n  model: x\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
      "utf8",
    );
    const { usedDefault, config } = await resolveConfig(configPath);
    expect(usedDefault).toBe(false);
    expect(config.reviewer.model).toBe("x");
  });

  it("reports usedDefault=true and returns the built-in defaults when the config file is missing", async () => {
    const { usedDefault, config } = await resolveConfig(join(dir, "missing.yml"));
    expect(usedDefault).toBe(true);
    expect(config.reviewer).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });
});
