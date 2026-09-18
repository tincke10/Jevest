#!/usr/bin/env -S npx tsx
/**
 * collect-hunks.ts — Phase 0 spike dataset collector for Jevest (SPEC.md §5 Fase 0, §8 FR-3/FR-8).
 *
 * Builds datasets/hunks.jsonl: ~50 DEFECT hunks (the pre-fix / buggy state of code
 * touched by a real bugfix commit) and ~50 BENIGN hunks (code touched by a
 * non-bugfix commit: docs/refactor/test/feature/deps/config), drawn from a
 * curated list of well-known, MIT/Apache-licensed open source TypeScript repos.
 *
 * Usage:
 *   npx tsx scripts/dataset/collect-hunks.ts [options]
 *
 * Options:
 *   --repos owner/name,owner/name   Comma-separated repo list.
 *                                   Default: colinhacks/zod,vitest-dev/vitest,
 *                                            honojs/hono,trpc/trpc,fastify/fastify
 *   --target-defect N               Target number of DEFECT hunks (default 50)
 *   --target-benign N               Target number of BENIGN hunks (default 50)
 *   --out path                      Output JSONL path (default: datasets/hunks.jsonl,
 *                                   relative to CWD — run this from the repo root)
 *   --workdir path                  Directory to shallow/partial-clone repos into.
 *                                   Default: a fresh dir under os.tmpdir().
 *                                   IMPORTANT: never point this at the project repo;
 *                                   use a scratch/temp directory.
 *   --max-scan N                    Max recent commits scanned per repo per category
 *                                   (default 600)
 *   --keep-clones                   Do not delete clones after the run (debugging)
 *   --append                        Append to --out instead of overwriting it
 *
 * Requirements: `git` and `gh` (GitHub CLI, authenticated — `gh auth login`) on PATH.
 * No npm dependencies; run with `npx tsx` (Node 20+, plain TypeScript via tsx's
 * on-the-fly transpilation, no build step).
 *
 * ---------------------------------------------------------------------------
 * GROUND-TRUTH HEURISTIC (semi-automatic — see datasets/README.md for the full
 * labeling protocol; every record is emitted with needs_manual_review: true):
 *
 *   DEFECT candidate:
 *     - Commit lands on the repo's default branch (squash-merge commits from PRs
 *       land there directly in every repo in the default list).
 *     - Commit subject matches the Conventional Commits "fix" type, e.g.
 *       "fix(scope): message" or "fix: message".
 *     - The commit's associated pull request (via GitHub's
 *       commits/{sha}/pulls API) either:
 *         (a) carries a "bug" label, OR
 *         (b) its body/message contains a GitHub auto-close reference to an
 *             issue in the same repo (fixes/closes/resolves #N).
 *     - We record the PARENT (pre-fix) state of the hunk as "before" — the
 *       BUGGY code — never the fix. `label.defect = true`.
 *
 *   BENIGN candidate:
 *     - Commit subject matches docs/refactor/test/feat/chore/perf (NOT fix).
 *     - The commit's associated PR body/message contains NO issue-closing
 *       reference (guards against a chore/refactor that quietly also closes a
 *       bug report). If it does, the commit is skipped as ambiguous.
 *     - `label.defect = false`.
 *
 * Both categories exclude generated code, lockfiles, snapshots, and anything
 * outside plain `.ts` files (see EXCLUDE_PATH_RE below), and only keep hunks
 * of roughly 10-80 changed/context lines (see MIN/MAX_HUNK_LINES).
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Category = "bugfix" | "refactor" | "docs" | "test" | "feature" | "deps" | "config";

interface HunkRecord {
  id: string;
  repo: string;
  license: string;
  commit: string;
  parent: string;
  file: string;
  language: "typescript";
  hunk_header: string;
  before: string;
  after: string;
  diff: string;
  label: {
    defect: boolean;
    category: Category;
    touches_public_api: boolean | null;
    touches_security: boolean | null;
    source: "commit-heuristic";
  };
  evidence: {
    commit_message: string;
    issue_url: string | null;
    pr_url: string | null;
  };
  needs_manual_review: true;
}

interface ParsedHunk {
  path: string;
  hunkHeader: string;
  before: string;
  after: string;
  diff: string;
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_REPOS = [
  "colinhacks/zod",
  "vitest-dev/vitest",
  "honojs/hono",
  "trpc/trpc",
  "fastify/fastify",
];

const MIN_HUNK_LINES = 10;
const MAX_HUNK_LINES = 80;

// Only plain .ts files; skip generated code, lockfiles, snapshots, type decls.
const EXCLUDE_PATH_RE =
  /(^|\/)(dist|build|coverage|node_modules|__snapshots__|\.changeset|vendor)\//i;
const EXCLUDE_FILE_RE =
  /(\.snap|\.lock|\.min\.(ts|js)|\.generated\.ts|\.d\.ts|package-lock\.json)$/i;

const FIX_SUBJECT_RE = /^fix(\([^)]*\))?!?:/i;
const BENIGN_SUBJECT_RE = /^(docs|refactor|test|feat|chore|perf)(\([^)]*\))?!?:/i;

// chore(deps): ... -> deps ; docs -> docs ; test -> test ; feat -> feature
// refactor/perf -> refactor ; chore(<anything else>) -> config
const CATEGORY_BY_TYPE: Record<string, Category> = {
  fix: "bugfix",
  docs: "docs",
  test: "test",
  feat: "feature",
  refactor: "refactor",
  perf: "refactor",
};

const ISSUE_CLOSE_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

const PUBLIC_API_PATH_RE = /(^|\/)(src\/)?index\.ts$|(^|\/)mod\.ts$/i;
const SECURITY_PATH_RE = /(auth|crypto|security|jwt|session|password|token|csrf|cors)/i;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
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

const targetDefect = Number(args["target-defect"] ?? 50);
const targetBenign = Number(args["target-benign"] ?? 50);
const outPath = typeof args.out === "string" ? args.out : join("datasets", "hunks.jsonl");
const maxScan = Number(args["max-scan"] ?? 600);
const keepClones = Boolean(args["keep-clones"]);
const append = Boolean(args.append);

const workdir =
  typeof args.workdir === "string" ? args.workdir : mkdtempSync(join(tmpdir(), "jevest-dataset-"));

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function sh(cmd: string, cmdArgs: string[], cwd?: string): string {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ghJson<T>(apiPath: string): T | null {
  try {
    const out = sh("gh", ["api", apiPath]);
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function repoLicense(repo: string): string {
  const info = ghJson<{ license: { spdx_id: string } | null }>(`repos/${repo}`);
  return info?.license?.spdx_id ?? "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Repo cloning
// ---------------------------------------------------------------------------

function cloneRepo(repo: string): string {
  const dir = join(workdir, repo.replace("/", "__"));
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  console.error(`  cloning ${repo} (partial, blob:none) into ${dir} ...`);
  sh("gh", [
    "repo",
    "clone",
    repo,
    dir,
    "--",
    "--filter=blob:none",
    "--single-branch",
    "--no-tags",
  ]);
  return dir;
}

function cleanupRepo(dir: string) {
  if (keepClones) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

function parseHunksFromShow(diffText: string): ParsedHunk[] {
  const results: ParsedHunk[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).slice(1);

  for (const rawBlock of fileBlocks) {
    const block = `diff --git ${rawBlock}`;
    const headerMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)\n/);
    if (!headerMatch) continue;
    const path = headerMatch[2];

    if (/^(new file mode|deleted file mode|rename from|rename to)/m.test(block)) continue;
    if (/^Binary files /m.test(block)) continue;
    if (!path.endsWith(".ts")) continue;
    if (EXCLUDE_PATH_RE.test(path) || EXCLUDE_FILE_RE.test(path)) continue;

    const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;
    const starts: { index: number; header: string }[] = [];
    let m: RegExpExecArray | null = hunkHeaderRe.exec(block);
    while (m !== null) {
      starts.push({ index: m.index, header: m[0] });
      m = hunkHeaderRe.exec(block);
    }

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i].index;
      const end = i + 1 < starts.length ? starts[i + 1].index : block.length;
      const hunkBody = block.slice(start, end);
      const lines = hunkBody.split("\n").slice(1); // drop the @@ header line itself

      const before: string[] = [];
      const after: string[] = [];
      const diffLines: string[] = [starts[i].header];
      let changedLines = 0;

      for (const line of lines) {
        if (line.startsWith("\\ No newline")) continue;
        if (line === "") continue;
        if (line.startsWith("-")) {
          before.push(line.slice(1));
          diffLines.push(line);
          changedLines++;
        } else if (line.startsWith("+")) {
          after.push(line.slice(1));
          diffLines.push(line);
          changedLines++;
        } else if (line.startsWith(" ")) {
          before.push(line.slice(1));
          after.push(line.slice(1));
          diffLines.push(line);
          changedLines++;
        }
      }

      if (changedLines < MIN_HUNK_LINES || changedLines > MAX_HUNK_LINES) continue;

      results.push({
        path,
        hunkHeader: starts[i].header,
        before: before.join("\n"),
        after: after.join("\n"),
        diff: diffLines.join("\n"),
        lineCount: changedLines,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Commit classification
// ---------------------------------------------------------------------------

interface CommitInfo {
  sha: string;
  subject: string;
  type: string;
}

function listCandidateCommits(dir: string, subjectRe: RegExp, limit: number): CommitInfo[] {
  const raw = sh(
    "git",
    ["-C", dir, "log", "--no-merges", "-n", String(limit), "--pretty=format:%H%x1f%s"],
    dir,
  );
  const out: CommitInfo[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [sha, subject] = line.split("\x1f");
    if (!sha || !subject) continue;
    const match = subject.match(subjectRe);
    if (!match) continue;
    const typeMatch = subject.match(/^([a-z]+)/i);
    out.push({ sha, subject, type: (typeMatch?.[1] ?? "").toLowerCase() });
  }
  return out;
}

interface PrMeta {
  number: number;
  url: string;
  body: string;
  labels: string[];
}

function findAssociatedPr(repo: string, sha: string): PrMeta | null {
  const prs = ghJson<Array<{ number: number; html_url: string }>>(
    `repos/${repo}/commits/${sha}/pulls`,
  );
  if (!prs || prs.length === 0) return null;
  const number = prs[0].number;
  const pr = ghJson<{ body: string | null; labels: Array<{ name: string }>; html_url: string }>(
    `repos/${repo}/pulls/${number}`,
  );
  if (!pr) return null;
  return {
    number,
    url: pr.html_url,
    body: pr.body ?? "",
    labels: pr.labels.map((l) => l.name),
  };
}

function extractIssueUrl(repo: string, text: string): string | null {
  ISSUE_CLOSE_RE.lastIndex = 0;
  const match = ISSUE_CLOSE_RE.exec(text);
  if (!match) return null;
  return `https://github.com/${repo}/issues/${match[2]}`;
}

function categoryFor(type: string): Category {
  if (type === "chore") return "config"; // refined to "deps" below via subject sniff
  return CATEGORY_BY_TYPE[type] ?? "config";
}

function refineChoreCategory(subject: string): Category {
  if (/^chore\((deps?|dependencies)\)/i.test(subject) || /\bbump\b|\bupgrade\b/i.test(subject)) {
    return "deps";
  }
  return "config";
}

// ---------------------------------------------------------------------------
// Main collection
// ---------------------------------------------------------------------------

function makeRecord(
  repo: string,
  license: string,
  sha: string,
  parent: string,
  subject: string,
  hunk: ParsedHunk,
  n: number,
  defect: boolean,
  category: Category,
  issueUrl: string | null,
  prUrl: string | null,
): HunkRecord {
  const shortSha = sha.slice(0, 7);
  const repoSlug = repo.split("/")[1];
  return {
    id: `${repoSlug}-${shortSha}-${n}`,
    repo,
    license,
    commit: sha,
    parent,
    file: hunk.path,
    language: "typescript",
    hunk_header: hunk.hunkHeader,
    before: hunk.before,
    after: hunk.after,
    diff: hunk.diff,
    label: {
      defect,
      category,
      touches_public_api: PUBLIC_API_PATH_RE.test(hunk.path) ? true : null,
      touches_security: SECURITY_PATH_RE.test(hunk.path) ? true : null,
      source: "commit-heuristic",
    },
    evidence: {
      commit_message: subject,
      issue_url: issueUrl,
      pr_url: prUrl,
    },
    needs_manual_review: true,
  };
}

function collectFromRepo(
  repo: string,
  dir: string,
  license: string,
  needDefect: number,
  needBenign: number,
): { defect: HunkRecord[]; benign: HunkRecord[] } {
  const defect: HunkRecord[] = [];
  const benign: HunkRecord[] = [];

  if (needDefect > 0) {
    const candidates = listCandidateCommits(dir, FIX_SUBJECT_RE, maxScan);
    for (const c of candidates) {
      if (defect.length >= needDefect) break;
      const pr = findAssociatedPr(repo, c.sha);
      const hasBugLabel = pr?.labels.some((l) => l.toLowerCase() === "bug") ?? false;
      const issueUrl = pr ? extractIssueUrl(repo, pr.body) : extractIssueUrl(repo, c.subject);
      if (!hasBugLabel && !issueUrl) continue; // not verifiably a real bugfix

      let showOut: string;
      try {
        showOut = sh("git", ["-C", dir, "show", "--unified=5", "--no-color", c.sha], dir);
      } catch {
        continue;
      }
      const hunks = parseHunksFromShow(showOut);
      if (hunks.length === 0) continue;

      const parent = sh("git", ["-C", dir, "rev-parse", `${c.sha}^`], dir).trim();
      const hunk = hunks[0];
      defect.push(
        makeRecord(
          repo,
          license,
          c.sha,
          parent,
          c.subject,
          hunk,
          1,
          true,
          "bugfix",
          issueUrl,
          pr?.url ?? null,
        ),
      );
    }
  }

  if (needBenign > 0) {
    const candidates = listCandidateCommits(dir, BENIGN_SUBJECT_RE, maxScan);
    for (const c of candidates) {
      if (benign.length >= needBenign) break;
      const pr = findAssociatedPr(repo, c.sha);
      const issueUrl = pr ? extractIssueUrl(repo, pr.body) : extractIssueUrl(repo, c.subject);
      if (issueUrl) continue; // looks like it secretly closes a bug — skip, ambiguous

      let showOut: string;
      try {
        showOut = sh("git", ["-C", dir, "show", "--unified=5", "--no-color", c.sha], dir);
      } catch {
        continue;
      }
      const hunks = parseHunksFromShow(showOut);
      if (hunks.length === 0) continue;

      const parent = sh("git", ["-C", dir, "rev-parse", `${c.sha}^`], dir).trim();
      const hunk = hunks[0];
      let category = categoryFor(c.type);
      if (c.type === "chore") category = refineChoreCategory(c.subject);

      benign.push(
        makeRecord(
          repo,
          license,
          c.sha,
          parent,
          c.subject,
          hunk,
          1,
          false,
          category,
          null,
          pr?.url ?? null,
        ),
      );
    }
  }

  return { defect, benign };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  console.error(`Repos: ${repos.join(", ")}`);
  console.error(`Target: ${targetDefect} defect, ${targetBenign} benign`);
  console.error(`Workdir: ${workdir}`);
  console.error(`Output: ${outPath}`);

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(workdir, { recursive: true });

  if (!append) {
    writeFileSync(outPath, "");
  }

  const allDefect: HunkRecord[] = [];
  const allBenign: HunkRecord[] = [];

  const perRepoDefect = Math.ceil((targetDefect / repos.length) * 1.4);
  const perRepoBenign = Math.ceil((targetBenign / repos.length) * 1.4);

  for (const repo of repos) {
    if (allDefect.length >= targetDefect && allBenign.length >= targetBenign) break;

    console.error(`\n=== ${repo} ===`);
    const license = repoLicense(repo);
    console.error(`  license: ${license}`);
    if (!/^(MIT|Apache-2\.0)$/i.test(license)) {
      console.error(`  SKIPPING ${repo}: license "${license}" is not MIT/Apache-2.0`);
      continue;
    }

    let dir: string;
    try {
      dir = cloneRepo(repo);
    } catch (err) {
      console.error(`  clone failed for ${repo}: ${(err as Error).message}`);
      continue;
    }

    try {
      const remainingDefect = Math.max(0, targetDefect - allDefect.length);
      const remainingBenign = Math.max(0, targetBenign - allBenign.length);
      const wantDefect = Math.min(perRepoDefect, remainingDefect || perRepoDefect);
      const wantBenign = Math.min(perRepoBenign, remainingBenign || perRepoBenign);

      const { defect, benign } = collectFromRepo(repo, dir, license, wantDefect, wantBenign);
      console.error(`  collected: ${defect.length} defect, ${benign.length} benign`);

      allDefect.push(...defect);
      allBenign.push(...benign);

      for (const rec of [...defect, ...benign]) {
        appendFileSync(outPath, `${JSON.stringify(rec)}\n`);
      }
    } finally {
      cleanupRepo(dir);
    }
  }

  if (!keepClones) {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  console.error(`\nDone. Total: ${allDefect.length} defect, ${allBenign.length} benign.`);
  if (allDefect.length < targetDefect || allBenign.length < targetBenign) {
    console.error(
      `WARNING: fell short of targets (wanted ${targetDefect}/${targetBenign}). Add more repos with --repos or raise --max-scan.`,
    );
  }
}

main();
