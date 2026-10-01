import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringifyGoldenCase } from "../../src/application/eval/golden-set.js";
import type { GoldenCase } from "../../src/application/eval/golden-set.js";
import { parseRescoreArgs, runRescoreCli } from "./rescore.js";
import { parseEvalArgs, runEvalCli } from "./review.js";

describe("parseRescoreArgs (scripts/eval/rescore.ts)", () => {
  it("needs --run and --set, and defaults to the LLM matcher on opus at medium effort", () => {
    expect(parseRescoreArgs(["--run", "runs/v", "--set", "g.jsonl"])).toEqual({
      runDir: "runs/v",
      setPath: "g.jsonl",
      as: null,
      matcher: "claude-cli",
      matcherModel: "claude-opus-5-5",
      matcherEffort: "medium",
      matcherConcurrency: 4,
      concurrency: 1,
    });
    expect(() => parseRescoreArgs(["--set", "g"])).toThrow(/--run/);
    expect(() => parseRescoreArgs(["--run", "r"])).toThrow(/--set/);
  });

  it("parses --matcher, --matcher-model, --matcher-effort, --as and the concurrencies", () => {
    const options = parseRescoreArgs([
      "--run",
      "r",
      "--set",
      "g",
      "--matcher",
      "prefilter",
      "--matcher-model",
      "m",
      "--matcher-effort",
      "high",
      "--matcher-concurrency",
      "8",
      "--concurrency",
      "2",
      "--as",
      "v-relabeled",
    ]);
    expect(options).toMatchObject({
      matcher: "prefilter",
      matcherModel: "m",
      matcherEffort: "high",
      matcherConcurrency: 8,
      concurrency: 2,
      as: "v-relabeled",
    });
    expect(parseRescoreArgs(["--run", "r", "--set", "g", "--matcher", "llm"]).matcher).toBe(
      "claude-cli",
    );
  });

  it("rejects an unsafe --as name and unknown flags", () => {
    expect(() => parseRescoreArgs(["--run", "r", "--set", "g", "--as", "../x"])).toThrow(/--as/);
    expect(() => parseRescoreArgs(["--run", "r", "--set", "g", "--nope"])).toThrow(/--nope/);
  });
});

describe("runRescoreCli", () => {
  let dir: string;
  const issue = (id: string, line: number, title: string) => ({
    id,
    file: "a.ts",
    line,
    title,
    severity: "high" as const,
    verdict: "real" as const,
  });
  const goldenCase = (issues: GoldenCase["issues"]): GoldenCase => ({
    schema: 1,
    id: "c1",
    repoPath: "repo",
    baseRef: "a",
    headRef: "b",
    title: "T",
    description: "",
    issues,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-rescore-cli-"));
    // A stored run: one imported finding at a.ts:100, no issue near it yet.
    await writeFile(
      join(dir, "old.jsonl"),
      `${stringifyGoldenCase(goldenCase([issue("I1", 3, "Null deref")]))}\n`,
    );
    await mkdir(join(dir, "import"));
    await writeFile(
      join(dir, "import", "c1.json"),
      JSON.stringify({
        findings: [{ file: "a.ts", line: 100, claim: "Leaks the token" }],
        costUsd: 2,
      }),
    );
    await runEvalCli(
      parseEvalArgs([
        "--set",
        join(dir, "old.jsonl"),
        "--variant",
        "base",
        "--import",
        join(dir, "import"),
        "--out",
        join(dir, "runs"),
        "--matcher",
        "prefilter",
      ]),
      () => {},
    );
    // The set grows an issue the stored finding is about; the import is gone.
    await rm(join(dir, "import"), { recursive: true });
    await writeFile(
      join(dir, "new.jsonl"),
      `${stringifyGoldenCase(goldenCase([issue("I1", 3, "Null deref"), issue("I2", 100, "Leaks the token")]))}\n`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("re-scores the stored candidates in place, without the original source", async () => {
    const before = JSON.parse(await readFile(join(dir, "runs/base/results.json"), "utf8"));
    expect(before.totals.shown.unlabeled).toBe(1);
    const lines: string[] = [];
    await runRescoreCli(
      parseRescoreArgs([
        "--run",
        join(dir, "runs/base"),
        "--set",
        join(dir, "new.jsonl"),
        "--matcher",
        "prefilter",
      ]),
      (line) => lines.push(line),
    );
    const after = JSON.parse(await readFile(join(dir, "runs/base/results.json"), "utf8"));
    expect(after.variant).toBe("base");
    expect(after.totals.shown.unlabeled).toBe(0);
    expect(after.cases[0].candidates[0].issueId).toBe("I2");
    expect(after.totals.costUsd).toBe(2);
    expect(after.source).toMatchObject({ type: "rescore", original: { type: "import" } });
    const report = await readFile(join(dir, "runs/base/report.md"), "utf8");
    expect(report).toContain("# Eval: base");
    expect(lines.join("\n")).toContain("results.json");
  });

  it("writes a new variant next to the run with --as and leaves the run untouched", async () => {
    await runRescoreCli(
      parseRescoreArgs([
        "--run",
        join(dir, "runs/base"),
        "--set",
        join(dir, "new.jsonl"),
        "--matcher",
        "prefilter",
        "--as",
        "base-v2",
      ]),
      () => {},
    );
    const fresh = JSON.parse(await readFile(join(dir, "runs/base-v2/results.json"), "utf8"));
    expect(fresh.variant).toBe("base-v2");
    expect(fresh.totals.shown.unlabeled).toBe(0);
    expect((await stat(join(dir, "runs/base-v2/report.md"))).isFile()).toBe(true);
    const old = JSON.parse(await readFile(join(dir, "runs/base/results.json"), "utf8"));
    expect(old.totals.shown.unlabeled).toBe(1);
  });
});
