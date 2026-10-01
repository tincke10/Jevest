import { execFileSync } from "node:child_process";
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
  resolveLocalWorkingTree,
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
      fullFile: false,
      impactContext: false,
      requireEvidence: false,
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

describe("resolveLocalWorkingTree (scripts/review/run.ts)", () => {
  async function config(reviewer: Partial<JevestConfig["reviewer"]>): Promise<JevestConfig> {
    const { config: base } = await resolveConfig(join(tmpdir(), "jevest-missing-config.yml"));
    return {
      ...base,
      reviewer: { ...base.reviewer, provider: "anthropic", model: "m", ...reviewer },
    };
  }

  it("does nothing when every layer is off", async () => {
    let prepared = false;
    const resolved = await resolveLocalWorkingTree({
      config: await config({}),
      gitRange: { base: "a", head: "b" },
      repoDir: "/repo",
      log: () => {},
      prepare: async () => {
        prepared = true;
        throw new Error("unreachable");
      },
    });
    expect(prepared).toBe(false);
    expect(resolved.workingTree).toBeUndefined();
    expect(resolved.unavailableReason).toBeUndefined();
  });

  it("has no checkout in --diff mode, and says why", async () => {
    const resolved = await resolveLocalWorkingTree({
      config: await config({ impactContext: true }),
      gitRange: null,
      repoDir: "/repo",
      log: () => {},
    });
    expect(resolved.workingTree).toBeUndefined();
    expect(resolved.unavailableReason).toBe("--diff mode has no checkout of the head");
  });

  it("prepares a checkout of the head in --git mode, logs it, and cleans it up", async () => {
    const lines: string[] = [];
    let cleaned = false;
    const resolved = await resolveLocalWorkingTree({
      config: await config({ requireEvidence: true }),
      gitRange: { base: "a", head: "feedface" },
      repoDir: "/repo",
      log: (line) => lines.push(line),
      prepare: async (options) => {
        expect(options).toMatchObject({ repoDir: "/repo", head: "feedface" });
        return {
          root: "/tmp/tree",
          kind: "partial-worktree",
          skippedFiles: 3,
          totalFiles: 10,
          cleanup: async () => {
            cleaned = true;
          },
        };
      },
    });
    expect(resolved.workingTree).toBeDefined();
    expect(lines).toContain(
      "[review] head checkout: partial-worktree at /tmp/tree (3 of 10 files skipped: blobs not in the local object store)",
    );
    await resolved.cleanup();
    expect(cleaned).toBe(true);
  });
});

describe("runLocalReview --git with code context (real git, scripts/review/run.ts)", () => {
  let dir: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
      cwd: join(dir, "repo"),
      env,
      encoding: "utf8",
    }).trim();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-review-git-"));
    await mkdir(join(dir, "repo", "src"), { recursive: true });
    git("init", "-q");
    await writeFile(
      join(dir, "repo", "src/total.ts"),
      "export function computeTotal(items) {\n  return items.reduce(sumPlain, 0);\n}\n",
    );
    await writeFile(join(dir, "repo", "src/pay.ts"), "const due = computeTotal(cart);\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("checks the head out in a temporary worktree, logs per-hunk context stats, and removes it", async () => {
    const base = git("rev-parse", "HEAD");
    await writeFile(
      join(dir, "repo", "src/total.ts"),
      "export function computeTotal(items) {\n  return items.reduce(sumWithTax, 0);\n}\n",
    );
    git("commit", "-q", "-am", "head");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", base);

    const { config: defaults } = await resolveConfig(join(dir, "missing.yml"));
    const config: JevestConfig = {
      ...defaults,
      reviewer: {
        ...defaults.reviewer,
        fullFile: true,
        impactContext: true,
        requireEvidence: true,
      },
    };
    const lines: string[] = [];
    const result = await runLocalReview({
      options: {
        diffFile: null,
        gitRange: { base, head },
        mode: "dry-run",
        outDir: join(dir, "out"),
      },
      config,
      repoDir: join(dir, "repo"),
      spendLedgerPath: join(dir, "ledger.json"),
      log: (line) => lines.push(line),
    });

    expect(result.failedClosed).toBe(false);
    expect(lines.some((l) => l.startsWith("[review] head checkout: worktree at "))).toBe(true);
    expect(result.codeContext?.hunks[0]?.fullFile?.segments[0]?.lines[1]).toContain("sumWithTax");
    const hunkLine = lines.find((l) => l.startsWith("[review] context src/total.ts"));
    expect(hunkLine).toMatch(/symbols=\d+ \(.*sumWithTax.*\)/);
    expect(hunkLine).toMatch(/fullFile=full \d+ chars/);
    expect(lines.some((l) => l.startsWith("[review] code context: "))).toBe(true);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });
});
