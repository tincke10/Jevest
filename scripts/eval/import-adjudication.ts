#!/usr/bin/env -S npx tsx
/**
 * Builds a golden set from adjudication files (docs/EVAL.md "Building a
 * set from adjudications").
 *
 * Usage:
 *   pnpm eval:import-adjudication --adjudication <dir> [--adjudication-v2 <dir>]
 *     --meta <dir> --repo <git repo> --out <golden.jsonl>
 *     [--base-ref <ref>] [--head-ref <ref, {caseId} allowed>]
 *     [--anchors <dir>] [--export-anchors <dir>]
 *
 * Each `<caseId>.json` in `--adjudication` is one case; `--adjudication-v2`
 * may add `new_issues` for the same case id. `--meta` has
 * `<caseId>-meta.json` (or `<caseId>.json`) with `title`, `body`,
 * `baseRefName`, `headRefName`. In `--repo`, the head is `--head-ref` (or
 * the meta's `headRefName`) and the base is the merge-base of `--base-ref`
 * (or `baseRefName`) and the head, both stored as SHAs so the set does not
 * move with the branches. `--repo` is also each case's `repoPath`.
 *
 * `--anchors` holds import-format reviews (`<caseId>.json`,
 * `{ findings: [{ file, line, claim }] }`) used to locate issues;
 * `--export-anchors` writes them back normalized, ready for
 * `pnpm eval:review --import`.
 *
 * Keep client sets OUTSIDE this repo (default `~/.jevest/evals/`).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AdjudicationFile,
  type AnchorFinding,
  convertAdjudication,
} from "../../src/application/eval/adjudication-import.js";
import { stringifyGoldenCase } from "../../src/application/eval/golden-set.js";

const execFileAsync = promisify(execFile);

export interface ImportOptions {
  readonly adjudicationDir: string;
  readonly adjudicationV2Dir: string | null;
  readonly metaDir: string;
  readonly repo: string;
  readonly outPath: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly anchorsDir: string | null;
  readonly exportAnchorsDir: string | null;
}

const FLAGS: Readonly<Record<string, keyof ImportOptions>> = {
  "--adjudication": "adjudicationDir",
  "--adjudication-v2": "adjudicationV2Dir",
  "--meta": "metaDir",
  "--repo": "repo",
  "--out": "outPath",
  "--base-ref": "baseRef",
  "--head-ref": "headRef",
  "--anchors": "anchorsDir",
  "--export-anchors": "exportAnchorsDir",
};

export function parseImportArgs(argv: readonly string[]): ImportOptions {
  const values: Partial<Record<keyof ImportOptions, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const key = FLAGS[arg];
    if (key === undefined) throw new Error(`unknown flag "${arg}"`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`flag "${arg}" requires a value`);
    values[key] = value;
  }
  for (const [flag, key] of [
    ["--adjudication", "adjudicationDir"],
    ["--meta", "metaDir"],
    ["--repo", "repo"],
    ["--out", "outPath"],
  ] as const) {
    if (values[key] === undefined) throw new Error(`${flag} is required`);
  }
  return {
    adjudicationDir: values.adjudicationDir as string,
    adjudicationV2Dir: values.adjudicationV2Dir ?? null,
    metaDir: values.metaDir as string,
    repo: values.repo as string,
    outPath: values.outPath as string,
    baseRef: values.baseRef ?? null,
    headRef: values.headRef ?? null,
    anchorsDir: values.anchorsDir ?? null,
    exportAnchorsDir: values.exportAnchorsDir ?? null,
  };
}

interface ImportFinding {
  readonly file?: unknown;
  readonly line?: unknown;
  readonly lineEnd?: unknown;
  readonly severity?: unknown;
  readonly claim?: unknown;
  readonly title?: unknown;
  readonly kind?: unknown;
  readonly [other: string]: unknown;
}

/** Only the import-format fields (docs/EVAL.md "Importing a review") of each finding. */
export function normalizeImportedReview(review: {
  readonly findings?: readonly ImportFinding[];
  readonly [other: string]: unknown;
}): {
  findings: Record<string, unknown>[];
} {
  const keys = ["file", "line", "lineEnd", "severity", "claim", "title", "kind"] as const;
  return {
    findings: (review.findings ?? []).map((finding) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (finding[key] !== undefined) out[key] = finding[key];
      return out;
    }),
  };
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return await readJson(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseImportArgs(process.argv.slice(2));
  const caseIds = (await readdir(options.adjudicationDir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
  const lines: string[] = [];
  const repoPath = resolve(options.repo);

  for (const caseId of caseIds) {
    const v1 = (await readJson(
      join(options.adjudicationDir, `${caseId}.json`),
    )) as AdjudicationFile;
    const v2 =
      options.adjudicationV2Dir === null
        ? null
        : ((await readJsonIfExists(
            join(options.adjudicationV2Dir, `${caseId}.json`),
          )) as AdjudicationFile | null);
    const meta = ((await readJsonIfExists(join(options.metaDir, `${caseId}-meta.json`))) ??
      (await readJson(join(options.metaDir, `${caseId}.json`)))) as Record<string, unknown>;

    const headName = options.headRef?.replaceAll("{caseId}", caseId) ?? String(meta.headRefName);
    const baseName = options.baseRef?.replaceAll("{caseId}", caseId) ?? String(meta.baseRefName);
    const headRef = (await git(repoPath, ["rev-parse", "--verify", `${headName}^{commit}`])).trim();
    const baseTip = (await git(repoPath, ["rev-parse", "--verify", `${baseName}^{commit}`])).trim();
    const baseRef = (await git(repoPath, ["merge-base", baseTip, headRef])).trim();
    const files = (await git(repoPath, ["ls-tree", "-r", "--name-only", headRef]))
      .split("\n")
      .filter(Boolean);
    const changedFiles = (await git(repoPath, ["diff", "--name-only", baseRef, headRef]))
      .split("\n")
      .filter(Boolean);

    let anchors: AnchorFinding[] = [];
    if (options.anchorsDir !== null) {
      const review = (await readJsonIfExists(join(options.anchorsDir, `${caseId}.json`))) as {
        findings?: ImportFinding[];
      } | null;
      if (review !== null) {
        anchors = (review.findings ?? [])
          .filter((f) => typeof f.file === "string")
          .map((f) => ({
            file: f.file as string,
            line: typeof f.line === "number" ? f.line : null,
            text: String(f.claim ?? f.title ?? ""),
          }));
        if (options.exportAnchorsDir !== null) {
          await mkdir(options.exportAnchorsDir, { recursive: true });
          await writeFile(
            join(options.exportAnchorsDir, `${caseId}.json`),
            `${JSON.stringify(normalizeImportedReview(review), null, 2)}\n`,
            "utf8",
          );
        }
      }
    }

    const goldenCase = convertAdjudication({
      caseId,
      v1,
      ...(v2 !== null ? { v2 } : {}),
      meta: { title: String(meta.title ?? ""), body: String(meta.body ?? "") },
      repo: { repoPath, baseRef, headRef, files, changedFiles },
      anchors,
    });
    const located = goldenCase.issues.filter((i) => i.file !== null).length;
    console.log(
      `[eval] ${caseId}: ${goldenCase.issues.length} issue(s), ${located} located, base ${baseRef.slice(0, 10)} head ${headRef.slice(0, 10)}`,
    );
    lines.push(stringifyGoldenCase(goldenCase));
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`[eval] wrote ${lines.length} case(s) to ${options.outPath}`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error("[eval] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
