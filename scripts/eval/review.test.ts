import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringifyGoldenCase } from "../../src/application/eval/golden-set.js";
import { parseEvalArgs, resolveCasePath, runEvalCli } from "./review.js";

describe("parseEvalArgs (scripts/eval/review.ts)", () => {
  it("parses a pipeline variant with overrides", () => {
    const options = parseEvalArgs([
      "--set",
      "g.jsonl",
      "--variant",
      "v1",
      "--config",
      "c.yml",
      "--override",
      "reviewer.model=x",
      "--override",
      "budgetUsd=2",
      "--overrides",
      "o.yml",
      "--mode",
      "replay",
      "--out",
      "runs",
      "--cases",
      "a,b",
    ]);
    expect(options).toMatchObject({
      setPath: "g.jsonl",
      variant: "v1",
      outDir: "runs",
      caseIds: ["a", "b"],
      matcher: "claude-cli",
      source: {
        type: "pipeline",
        configPath: "c.yml",
        mode: "replay",
        overridesPath: "o.yml",
        overrides: ["reviewer.model=x", "budgetUsd=2"],
      },
    });
  });

  it("parses an import variant and a matcher choice", () => {
    const options = parseEvalArgs([
      "--set",
      "g.jsonl",
      "--variant",
      "base",
      "--import",
      "dir",
      "--out",
      "runs",
      "--matcher",
      "prefilter",
      "--matcher-model",
      "m",
    ]);
    expect(options.source).toEqual({ type: "import", dir: "dir" });
    expect(options.matcher).toBe("prefilter");
    expect(options.matcherModel).toBe("m");
  });

  it("defaults the pipeline mode to dry-run", () => {
    const options = parseEvalArgs(["--set", "g", "--variant", "v", "--out", "o", "--config", "c"]);
    expect(options.source).toMatchObject({ type: "pipeline", mode: "dry-run" });
  });

  it("requires --set, --variant, --out and exactly one of --config or --import", () => {
    expect(() => parseEvalArgs(["--variant", "v", "--out", "o", "--import", "d"])).toThrow(/--set/);
    expect(() => parseEvalArgs(["--set", "s", "--out", "o", "--import", "d"])).toThrow(/--variant/);
    expect(() => parseEvalArgs(["--set", "s", "--variant", "v", "--import", "d"])).toThrow(/--out/);
    expect(() => parseEvalArgs(["--set", "s", "--variant", "v", "--out", "o"])).toThrow(
      /--config.*--import/,
    );
    expect(() =>
      parseEvalArgs([
        "--set",
        "s",
        "--variant",
        "v",
        "--out",
        "o",
        "--import",
        "d",
        "--config",
        "c",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a variant name that is not a safe directory name", () => {
    expect(() =>
      parseEvalArgs(["--set", "s", "--variant", "../x", "--out", "o", "--import", "d"]),
    ).toThrow(/--variant/);
  });
});

describe("parseEvalArgs --concurrency", () => {
  const base = ["--set", "g", "--variant", "v", "--out", "o", "--import", "d"];
  it("defaults to 1 and accepts a positive integer", () => {
    expect(parseEvalArgs(base).concurrency).toBe(1);
    expect(parseEvalArgs([...base, "--concurrency", "3"]).concurrency).toBe(3);
  });
  it("rejects zero, negatives and non-integers", () => {
    for (const bad of ["0", "-1", "1.5", "x"]) {
      expect(() => parseEvalArgs([...base, "--concurrency", bad])).toThrow(/--concurrency/);
    }
  });
});

describe("resolveCasePath", () => {
  it("expands ~ and resolves relative paths against the set's directory", () => {
    expect(resolveCasePath("~/r", "/sets", "/home/me")).toBe("/home/me/r");
    expect(resolveCasePath("repo", "/sets", "/home/me")).toBe("/sets/repo");
    expect(resolveCasePath("/abs", "/sets", "/home/me")).toBe("/abs");
  });
});

describe("runEvalCli with an imported review", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-eval-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes results.json and report.md under <out>/<variant>", async () => {
    const setPath = join(dir, "golden.jsonl");
    await writeFile(
      setPath,
      `${stringifyGoldenCase({
        schema: 1,
        id: "c1",
        repoPath: "repo",
        baseRef: "a",
        headRef: "b",
        title: "T",
        description: "",
        issues: [
          {
            id: "I1",
            file: "a.ts",
            line: 3,
            title: "Null deref",
            severity: "medium",
            verdict: "real",
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "c1.json"),
      JSON.stringify({ findings: [{ file: "a.ts", line: 4, claim: "null", severity: "low" }] }),
      "utf8",
    );
    const lines: string[] = [];
    await runEvalCli(
      parseEvalArgs([
        "--set",
        setPath,
        "--variant",
        "base",
        "--import",
        dir,
        "--out",
        join(dir, "runs"),
        "--matcher",
        "prefilter",
      ]),
      (line) => lines.push(line),
    );
    const results = JSON.parse(await readFile(join(dir, "runs/base/results.json"), "utf8"));
    expect(results.totals.shown.targetsFound).toBe(1);
    const report = await readFile(join(dir, "runs/base/report.md"), "utf8");
    expect(report).toContain("# Eval: base");
  });
});
