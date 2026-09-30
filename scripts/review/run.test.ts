import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JevestConfig } from "../../src/adapters/config/jevest-config.js";
import {
  parseArgs,
  resolveConfig,
  resolveLocalCalibration,
  resolveLocalProductContext,
  runLocalReview,
} from "./run.js";

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
    expect(config.reviewer).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      language: "es",
      narrative: true,
      descriptionContext: true,
    });
  });
});

describe("resolveLocalProductContext (scripts/review/run.ts)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-review-ctx-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the context file from the working tree in --diff mode (no base sha to read from)", async () => {
    await mkdir(join(dir, ".jevest"), { recursive: true });
    await writeFile(
      join(dir, ".jevest/context.yml"),
      "areas:\n  - name: core\n    paths: ['src/**']\n    criticality: high\n",
      "utf8",
    );
    const context = await resolveLocalProductContext({
      repoDir: dir,
      contextPath: ".jevest/context.yml",
      gitRange: null,
    });
    expect(context.areas.map((a) => a.name)).toEqual(["core"]);
  });

  it("returns the empty context when the file is missing in --diff mode", async () => {
    const context = await resolveLocalProductContext({
      repoDir: dir,
      contextPath: ".jevest/context.yml",
      gitRange: null,
    });
    expect(context.areas).toEqual([]);
  });

  it("reads the context file at the BASE ref via git in --git mode, never the head", async () => {
    const calls: Array<{ path: string; sha: string }> = [];
    const context = await resolveLocalProductContext({
      repoDir: dir,
      contextPath: ".jevest/context.yml",
      gitRange: { base: "main", head: "feature" },
      fetchFileAt: async (path, sha) => {
        calls.push({ path, sha });
        return "areas:\n  - name: ci\n    paths: ['.github/**']\n";
      },
    });
    expect(calls).toEqual([{ path: ".jevest/context.yml", sha: "main" }]);
    expect(context.areas.map((a) => a.name)).toEqual(["ci"]);
  });

  it("throws naming the source when the file is invalid", async () => {
    await mkdir(join(dir, ".jevest"), { recursive: true });
    await writeFile(join(dir, ".jevest/context.yml"), "areas: [", "utf8");
    await expect(
      resolveLocalProductContext({
        repoDir: dir,
        contextPath: ".jevest/context.yml",
        gitRange: null,
      }),
    ).rejects.toThrow(/\.jevest\/context\.yml/);
  });
});

describe("resolveLocalCalibration (scripts/review/run.ts)", () => {
  let dir: string;

  const VALID = JSON.stringify({
    version: 1,
    question: "is_real_defect",
    map: { method: "platt", a: 0.95, b: -1.65 },
  });

  function findingFilter(
    overrides: Partial<JevestConfig["findingFilter"]> = {},
  ): JevestConfig["findingFilter"] {
    return {
      mode: "annotate",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-review-calib-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is the identity, reading nothing, when calibration is "none"', async () => {
    const map = await resolveLocalCalibration({
      repoDir: dir,
      findingFilter: findingFilter(),
      gitRange: null,
    });
    expect(map).toEqual({ method: "none" });
  });

  it("reads the map from the working tree in --diff mode", async () => {
    await mkdir(join(dir, ".jevest"), { recursive: true });
    await writeFile(join(dir, ".jevest/calibration.json"), VALID, "utf8");

    const map = await resolveLocalCalibration({
      repoDir: dir,
      findingFilter: findingFilter({ calibration: "file" }),
      gitRange: null,
    });
    expect(map).toEqual({ method: "platt", a: 0.95, b: -1.65 });
  });

  it("reads it from the BASE ref in --git mode, never the working tree", async () => {
    const seen: { path: string; sha: string }[] = [];
    const map = await resolveLocalCalibration({
      repoDir: dir,
      findingFilter: findingFilter({ calibration: "file" }),
      gitRange: { base: "main", head: "HEAD" },
      fetchFileAt: async (path, sha) => {
        seen.push({ path, sha });
        return VALID;
      },
    });
    expect(map).toEqual({ method: "platt", a: 0.95, b: -1.65 });
    expect(seen).toEqual([{ path: ".jevest/calibration.json", sha: "main" }]);
  });

  it("throws naming the path when the config asks for a map that is not there", async () => {
    await expect(
      resolveLocalCalibration({
        repoDir: dir,
        findingFilter: findingFilter({ calibration: "file" }),
        gitRange: null,
      }),
    ).rejects.toThrow(/calibration\.json/);
  });

  it("throws on an invalid map instead of falling back to the identity", async () => {
    await mkdir(join(dir, ".jevest"), { recursive: true });
    await writeFile(join(dir, ".jevest/calibration.json"), "{ not json", "utf8");
    await expect(
      resolveLocalCalibration({
        repoDir: dir,
        findingFilter: findingFilter({ calibration: "file" }),
        gitRange: null,
      }),
    ).rejects.toThrow(/calibration\.json/);
  });
});

describe("runLocalReview (scripts/review/run.ts)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-review-local-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the pipeline in dry-run over a diff file, with the given title, body and ledger path", async () => {
    const diffPath = join(dir, "change.diff");
    await writeFile(
      diffPath,
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
      "utf8",
    );
    const { config } = await resolveConfig(join(dir, "missing.yml"));
    const outDir = join(dir, "out");
    const ledger = join(dir, "ledger", "spend.json");
    const lines: string[] = [];
    const result = await runLocalReview({
      options: { diffFile: diffPath, gitRange: null, mode: "dry-run", outDir },
      config,
      configLabel: "defaults",
      repoDir: dir,
      title: "Add b",
      body: "Adds a second constant",
      spendLedgerPath: ledger,
      log: (line) => lines.push(line),
    });
    expect(result.failedClosed).toBe(false);
    expect(result.triage).not.toBeNull();
    const review = JSON.parse(await readFile(join(outDir, "review.json"), "utf8"));
    expect(review.check).toBeDefined();
    await expect(stat(join(dir, ".jevest"))).rejects.toThrow();
    expect(lines.some((l) => l.includes("running pipeline (mode=dry-run, config=defaults)"))).toBe(
      true,
    );
  });
});
