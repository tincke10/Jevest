#!/usr/bin/env -S npx tsx
/**
 * collect-evidence.ts — fetches the issue and pull-request text behind each
 * hunk's fix, for the fix-aware oracle labeler (datasets/FINDINGS.md §10).
 *
 * `datasets/hunks.jsonl` records `evidence.issue_url` and `evidence.pr_url`
 * but not their content. The oracle labeler needs the content: a commit
 * message says what was changed, the issue says what was WRONG, and "what was
 * wrong" is exactly the question the label turns on.
 *
 * Writes `datasets/hunk-evidence.jsonl`, one record per hunk that had at least
 * one link resolve. It NEVER touches `datasets/hunks.jsonl` — that file is the
 * published phase-0 dataset and this is additive.
 *
 * Usage:
 *   pnpm dataset:evidence [--hunks <path>] [--out <path>] [--max-body-chars N]
 *                         [--force]
 *
 * Auth: the active `gh` account (`gh auth token`) or `GITHUB_TOKEN`. Every
 * source repo is public and every call is a read. A 404 (deleted, moved,
 * transferred) or any other per-link failure is reported and skipped, never
 * fatal: the labeler falls back to the commit message for that hunk.
 *
 * Rate limits: requests are sequential with a small delay, and the run stops
 * cleanly if the REST rate limit is hit, keeping what it already fetched. A
 * re-run is resumable — by default an existing output file is read first and
 * only missing hunks are fetched (`--force` refetches everything).
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import {
  type HunkEvidenceRecord,
  parseGitHubRef,
  parseHunkEvidenceJsonl,
  stringifyHunkEvidenceRecord,
  truncateEvidenceBody,
} from "../../src/application/findings/hunk-evidence.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/hunk-evidence.jsonl");
const DEFAULT_MAX_BODY_CHARS = 2000;
/** Polite spacing between reads; the REST limit for an authenticated user is 5000/hour. */
const DELAY_MS = 120;

interface CliOptions {
  readonly hunksPath: string;
  readonly outPath: string;
  readonly maxBodyChars: number;
  readonly force: boolean;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`flag "${flag}" requires a value`);
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let hunksPath = DEFAULT_HUNKS_PATH;
  let outPath = DEFAULT_OUT_PATH;
  let maxBodyChars = DEFAULT_MAX_BODY_CHARS;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--hunks":
        hunksPath = requireValue(argv, ++i, "--hunks");
        break;
      case "--out":
        outPath = requireValue(argv, ++i, "--out");
        break;
      case "--max-body-chars": {
        const raw = requireValue(argv, ++i, "--max-body-chars");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 100) {
          throw new Error(`--max-body-chars must be an integer >= 100, got "${raw}"`);
        }
        maxBodyChars = value;
        break;
      }
      case "--force":
        force = true;
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }
  return { hunksPath, outPath, maxBodyChars, force };
}

function resolveToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (token === "") throw new Error("gh auth token returned nothing; run `gh auth login`");
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const hunks = parseHunkRecordsJsonl(await readFile(options.hunksPath, "utf8"));

  const existing = new Map<string, HunkEvidenceRecord>();
  if (!options.force) {
    try {
      const raw = await readFile(options.outPath, "utf8");
      for (const record of parseHunkEvidenceJsonl(raw)) existing.set(record.hunkId, record);
      console.log(`[evidence] resuming: ${existing.size} hunk(s) already fetched`);
    } catch {
      // No previous run; start clean.
    }
  }

  const octokit = new Octokit({ auth: resolveToken() });
  const records: HunkEvidenceRecord[] = [];
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let stopped = false;

  async function fetchRef(
    url: string | null,
  ): Promise<{ title: string; body?: string } | null | "stop"> {
    const ref = parseGitHubRef(url);
    if (ref === null) return null;
    try {
      // A pull request IS an issue on GitHub: one endpoint serves both.
      const { data } = await octokit.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
      });
      const body = truncateEvidenceBody(data.body, options.maxBodyChars);
      return { title: data.title, ...(body !== undefined ? { body } : {}) };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 429) {
        console.warn(`[evidence] rate limited on ${url}; stopping and keeping what we have`);
        return "stop";
      }
      failed += 1;
      console.warn(`[evidence] ${status ?? "error"} on ${url}; skipping`);
      return null;
    }
  }

  for (const hunk of hunks) {
    if (stopped) break;
    const cached = existing.get(hunk.id);
    if (cached !== undefined) {
      records.push(cached);
      skipped += 1;
      continue;
    }
    if (hunk.evidence.issueUrl === null && hunk.evidence.prUrl === null) continue;

    const issue = await fetchRef(hunk.evidence.issueUrl);
    if (issue === "stop") {
      stopped = true;
      break;
    }
    await sleep(DELAY_MS);
    const pr = await fetchRef(hunk.evidence.prUrl);
    if (pr === "stop") {
      stopped = true;
      break;
    }
    await sleep(DELAY_MS);

    if (issue === null && pr === null) continue;
    records.push({
      hunkId: hunk.id,
      ...(issue !== null ? { issueTitle: issue.title } : {}),
      ...(issue?.body !== undefined ? { issueBody: issue.body } : {}),
      ...(pr !== null ? { prTitle: pr.title } : {}),
      ...(pr?.body !== undefined ? { prBody: pr.body } : {}),
      fetchedAt: new Date().toISOString(),
    });
    fetched += 1;
    if (fetched % 10 === 0) {
      console.log(`[evidence] ${fetched} fetched, ${records.length} record(s) so far`);
    }
  }

  await writeFile(
    options.outPath,
    `${records.map(stringifyHunkEvidenceRecord).join("\n")}\n`,
    "utf8",
  );

  console.log(
    `[evidence] wrote ${options.outPath}: ${records.length} record(s) ` +
      `(${fetched} newly fetched, ${skipped} reused, ${failed} link(s) failed)`,
  );
  const withIssue = records.filter((r) => r.issueTitle !== undefined).length;
  console.log(
    `[evidence] ${withIssue} hunk(s) have issue text, ${records.length - withIssue} PR only`,
  );
  if (stopped) {
    console.warn("[evidence] STOPPED EARLY on a rate limit; re-run to resume");
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[evidence] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
