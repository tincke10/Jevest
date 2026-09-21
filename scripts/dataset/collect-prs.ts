#!/usr/bin/env -S npx tsx
/**
 * collect-prs.ts — H7 "intent–change coherence" dataset collector
 * (SPEC.md §4.2). Thin IO wrapper: every selection rule lives in
 * `src/application/coherence/pr-selection.ts` and is unit tested there; this
 * file only talks to GitHub, applies those rules, and writes two JSONL files:
 *
 *   datasets/prs.jsonl              one PrRecord per merged, eligible PR
 *   datasets/coherence-pairs.jsonl  two CoherencePairs per PR (own description
 *                                   = coherent; another same-repo PR's
 *                                   description = incoherent), see
 *                                   generateCoherencePairs() for the protocol.
 *
 * Usage:
 *   pnpm dataset:prs [options]
 *
 * Options:
 *   --repos owner/name,...     Default: colinhacks/zod,vitest-dev/vitest,honojs/hono,trpc/trpc
 *   --per-repo N               Eligible PRs wanted per repo (default 25)
 *   --max-scan N               Max closed PRs scanned per repo (default 400)
 *   --seed N                   Seed for the crossed-description derangement (default 42)
 *   --out path                 PR records output (default datasets/prs.jsonl)
 *   --pairs-out path           Pairs output (default datasets/coherence-pairs.jsonl)
 *   --dataset-version N        Written to every record (default 1)
 *
 * Auth: `GITHUB_TOKEN` if set, otherwise the token of the active `gh` account
 * (`gh auth token`). Scanning is `pulls.list state=closed sort=updated
 * direction=desc`; a PR pays a `pulls.listFiles` call only after the cheap
 * metadata checks (merged, human author, stripped body length, no secret in
 * title/body) pass. If a repo cannot fill its share within --max-scan, the
 * other repos are scanned further to top up the total and the shortfall is
 * reported at the end.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Octokit } from "@octokit/rest";
import {
  type PrFile,
  type PrFileStatus,
  type PrRecord,
  stringifyCoherencePair,
  stringifyPrRecord,
} from "../../src/application/coherence/pr-record.js";
import {
  type Distribution,
  type RejectionReason,
  countBasenameLeaks,
  describeDistribution,
  generateCoherencePairs,
  isEligiblePr,
  stripPrTemplate,
} from "../../src/application/coherence/pr-selection.js";
import { redact } from "../../src/domain/redact.js";

const DEFAULT_REPOS = ["colinhacks/zod", "vitest-dev/vitest", "honojs/hono", "trpc/trpc"];
const MAX_PATCH_CHARS = 12_000;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
const repos = (typeof args.repos === "string" ? args.repos : DEFAULT_REPOS.join(","))
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const perRepo = Number(args["per-repo"] ?? 25);
const maxScan = Number(args["max-scan"] ?? 400);
const seed = Number(args.seed ?? 42);
const outPath = typeof args.out === "string" ? args.out : join("datasets", "prs.jsonl");
const pairsOutPath =
  typeof args["pairs-out"] === "string"
    ? args["pairs-out"]
    : join("datasets", "coherence-pairs.jsonl");
const datasetVersion = Number(args["dataset-version"] ?? 1);

// ---------------------------------------------------------------------------
// GitHub access
// ---------------------------------------------------------------------------

function resolveToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (token === "") throw new Error("gh auth token returned nothing; run `gh auth login`");
  return token;
}

function mapStatus(status: string): PrFileStatus {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      // "modified", "changed", "unchanged"
      return "modified";
  }
}

interface RawFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

/** Files as handed to the eligibility gate: raw patches, so the secret check sees everything. */
function toCandidateFiles(raw: readonly RawFile[]): PrFile[] {
  return raw.map((f) => ({
    path: f.filename,
    status: mapStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
  }));
}

/** Files as stored: patch redacted, dropped when absent or oversized. */
function toStoredFiles(raw: readonly RawFile[]): PrFile[] {
  return raw.map((f) => {
    const keepPatch = f.patch !== undefined && f.patch.length <= MAX_PATCH_CHARS;
    return {
      path: f.filename,
      status: mapStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      ...(keepPatch && f.patch !== undefined ? { patch: redact(f.patch).text } : {}),
    };
  });
}

type Rejections = Partial<Record<RejectionReason, number>>;

interface RepoScan {
  readonly repo: string;
  readonly records: PrRecord[];
  readonly rejections: Rejections;
  scanned: number;
  page: number;
  exhausted: boolean;
  /** Candidates already listed but not yet examined (carried across take() calls). */
  buffer: Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"];
}

function newScan(repo: string): RepoScan {
  return { repo, records: [], rejections: {}, scanned: 0, page: 1, exhausted: false, buffer: [] };
}

function bump(rejections: Rejections, reason: RejectionReason): void {
  rejections[reason] = (rejections[reason] ?? 0) + 1;
}

/**
 * Pulls eligible PRs from `scan.repo` until `want` more are collected, the
 * --max-scan budget is spent, or the repo has no more closed PRs.
 */
async function take(octokit: Octokit, scan: RepoScan, want: number): Promise<number> {
  const [owner, name] = scan.repo.split("/");
  if (owner === undefined || name === undefined) throw new Error(`bad repo "${scan.repo}"`);
  let taken = 0;

  while (taken < want && !scan.exhausted) {
    if (scan.buffer.length === 0) {
      if (scan.scanned >= maxScan) {
        scan.exhausted = true;
        break;
      }
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo: name,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: PAGE_SIZE,
        page: scan.page,
      });
      scan.page++;
      if (data.length === 0) {
        scan.exhausted = true;
        break;
      }
      scan.buffer = [...data];
    }

    const pr = scan.buffer.shift();
    if (pr === undefined) continue;
    scan.scanned++;
    if (scan.scanned > maxScan) {
      scan.exhausted = true;
      break;
    }

    const author = pr.user?.login ?? "";
    const rawBody = pr.body ?? "";
    const cheap = isEligiblePr({
      merged: pr.merged_at !== null,
      author,
      title: pr.title,
      body: rawBody,
    });
    if (!cheap.eligible) {
      bump(scan.rejections, cheap.reason);
      continue;
    }

    const { data: rawFiles } = await octokit.rest.pulls.listFiles({
      owner,
      repo: name,
      pull_number: pr.number,
      per_page: PAGE_SIZE,
    });
    const full = isEligiblePr({
      merged: pr.merged_at !== null,
      author,
      title: pr.title,
      body: rawBody,
      files: toCandidateFiles(rawFiles),
    });
    if (!full.eligible) {
      bump(scan.rejections, full.reason);
      continue;
    }

    scan.records.push({
      id: `${scan.repo}#${pr.number}`,
      repo: scan.repo,
      number: pr.number,
      title: redact(pr.title).text,
      body: redact(stripPrTemplate(rawBody)).text,
      labels: pr.labels.map((l) => l.name),
      author,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      mergedAt: pr.merged_at ?? "",
      files: toStoredFiles(rawFiles),
      datasetVersion,
    });
    taken++;
    console.error(
      `  ${scan.repo}#${pr.number} ok (${scan.records.length} kept, ${scan.scanned} scanned)`,
    );
  }
  return taken;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtDistribution(label: string, d: Distribution): string {
  return `  ${label.padEnd(14)} n=${d.n} min=${d.min} p25=${d.p25} p50=${d.p50} p75=${d.p75} p90=${d.p90} max=${d.max}`;
}

function printReport(
  scans: readonly RepoScan[],
  records: readonly PrRecord[],
  leaks: number,
): void {
  console.error("\n=== Per-repo counts ===");
  for (const s of scans) {
    console.error(`  ${s.repo.padEnd(20)} kept=${s.records.length} scanned=${s.scanned}`);
  }
  console.error("\n=== Rejections by reason (per repo) ===");
  for (const s of scans) {
    const parts = Object.entries(s.rejections)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, n]) => `${reason}=${n}`);
    console.error(`  ${s.repo.padEnd(20)} ${parts.join(" ") || "(none)"}`);
  }
  const totals: Rejections = {};
  for (const s of scans) {
    for (const [reason, n] of Object.entries(s.rejections)) {
      totals[reason as RejectionReason] = (totals[reason as RejectionReason] ?? 0) + n;
    }
  }
  console.error(
    `  ${"TOTAL".padEnd(20)} ${Object.entries(totals)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, n]) => `${reason}=${n}`)
      .join(" ")}`,
  );
  console.error("\n=== Distributions (kept PRs) ===");
  console.error(
    fmtDistribution("body chars", describeDistribution(records.map((r) => r.body.length))),
  );
  console.error(fmtDistribution("files", describeDistribution(records.map((r) => r.files.length))));
  console.error(
    fmtDistribution(
      "changed lines",
      describeDistribution(
        records.map((r) => r.files.reduce((n, f) => n + f.additions + f.deletions, 0)),
      ),
    ),
  );
  const patchless = records.reduce(
    (n, r) => n + r.files.filter((f) => f.patch === undefined).length,
    0,
  );
  console.error(`  files without patch (binary/absent/> ${MAX_PATCH_CHARS} chars): ${patchless}`);
  console.error("\n=== Leak check ===");
  console.error(
    `  incoherent pairs whose foreign description mentions a basename of the change: ${leaks}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const octokit = new Octokit({ auth: resolveToken() });
  const target = perRepo * repos.length;
  console.error(`Repos: ${repos.join(", ")}`);
  console.error(`Target: ${perRepo} per repo (${target} total), max-scan ${maxScan}, seed ${seed}`);

  const scans = repos.map(newScan);

  // Pass 1: each repo fills its own share.
  for (const scan of scans) {
    console.error(`\n=== ${scan.repo} ===`);
    await take(octokit, scan, perRepo);
    if (scan.records.length < perRepo) {
      console.error(
        `  SHORTFALL: ${scan.repo} reached ${scan.records.length}/${perRepo} within --max-scan ${maxScan}`,
      );
    }
  }

  // Pass 2: top up from whichever repos still have budget, round-robin.
  let total = scans.reduce((n, s) => n + s.records.length, 0);
  if (total < target) {
    console.error(`\n=== Top-up: ${target - total} short, scanning further in the other repos ===`);
    let progressed = true;
    while (total < target && progressed) {
      progressed = false;
      for (const scan of scans) {
        if (total >= target) break;
        if (scan.exhausted) continue;
        const got = await take(octokit, scan, 1);
        if (got > 0) {
          total += got;
          progressed = true;
        }
      }
    }
  }

  const records = scans.flatMap((s) => s.records);
  const pairs = generateCoherencePairs(records, seed);
  const leaks = countBasenameLeaks(records, pairs);

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(pairsOutPath), { recursive: true });
  writeFileSync(outPath, records.map((r) => `${stringifyPrRecord(r)}\n`).join(""));
  writeFileSync(pairsOutPath, pairs.map((p) => `${stringifyCoherencePair(p)}\n`).join(""));

  printReport(scans, records, leaks);
  console.error(
    `\nWrote ${records.length} records to ${outPath} and ${pairs.length} pairs to ${pairsOutPath}.`,
  );
  if (records.length < target) {
    console.error(`WARNING: ${records.length}/${target} records; raise --max-scan or add repos.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
