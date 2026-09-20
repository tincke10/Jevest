#!/usr/bin/env -S npx tsx
/**
 * collect-hunks.ts — Phase 0 spike dataset collector for Jevest (SPEC.md §5 Fase 0, §8 FR-3/FR-8).
 *
 * Builds datasets/hunks.jsonl (dataset_version 2): ~50 DEFECT hunks (the pre-fix /
 * buggy state of code touched by a real bugfix commit) and ~50 BENIGN hunks (code
 * touched by a non-bugfix commit: refactor/feature/deps/config), drawn from a
 * curated list of well-known, MIT/Apache-licensed open source TypeScript repos.
 *
 * Usage:
 *   npx tsx scripts/dataset/collect-hunks.ts [options]
 *
 * v2 command used to produce the committed dataset (see datasets/README.md §1
 * for the full rationale):
 *   npx tsx scripts/dataset/collect-hunks.ts \
 *     --workdir <scratch-dir> --target-defect 50 --target-benign 50 --max-scan 800
 *
 * Options:
 *   --repos owner/name,owner/name    Comma-separated BASE repo list, sampled first,
 *                                    evenly capped (see PER-REPO BALANCING below).
 *                                    Default: colinhacks/zod,vitest-dev/vitest,
 *                                             honojs/hono,trpc/trpc
 *   --fallback-repos owner/name,...  Extra repos used only to top up a shortfall
 *                                    after all base repos are processed (uncapped).
 *                                    Default: fastify/fastify
 *   --target-defect N                Target number of DEFECT hunks (default 50)
 *   --target-benign N                Target number of BENIGN hunks (default 50)
 *   --out path                       Output JSONL path (default: datasets/hunks.jsonl,
 *                                    relative to CWD — run this from the repo root)
 *   --workdir path                   Directory to shallow/partial-clone repos into.
 *                                    Default: a fresh dir under os.tmpdir().
 *                                    IMPORTANT: never point this at the project repo;
 *                                    use a scratch/temp directory.
 *   --max-scan N                     Max recent commits scanned per repo per category
 *                                    (default 600)
 *   --dataset-version N              Value written to every record's dataset_version
 *                                    field (default 2)
 *   --keep-clones                    Do not delete clones after the run (debugging)
 *   --append                         Append to --out instead of overwriting it
 *
 * Requirements: `git` and `gh` (GitHub CLI, authenticated — `gh auth login`) on PATH.
 * No npm dependencies; run with `npx tsx` (Node 20+, plain TypeScript via tsx's
 * on-the-fly transpilation, no build step).
 *
 * ---------------------------------------------------------------------------
 * GROUND-TRUTH HEURISTIC (semi-automatic — see datasets/README.md for the full
 * labeling protocol, the v1→v2 changelog, and the per-set path-distribution
 * report; every record is emitted with needs_manual_review: true):
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
 *     - The stored hunk must be an ELIGIBLE SOURCE hunk (see below) — never a
 *       test/doc/config hunk from the same commit. If the commit has no
 *       eligible source hunk, the commit is skipped entirely (v2 change: v1
 *       sometimes picked the fix commit's *test* hunk, which doesn't contain
 *       the defect — see datasets/README.md §4).
 *     - We record the PARENT (pre-fix) state of the hunk as "before" — the
 *       BUGGY code — never the fix. `label.defect = true`.
 *
 *   BENIGN candidate:
 *     - Commit subject matches refactor/feat/chore/perf (NOT fix, NOT docs,
 *       NOT test — v2 change: docs/test commits were dropped because they
 *       essentially never touch eligible source files, and in v1 they were
 *       the main source of a file-type confound, see datasets/README.md §4).
 *     - Its associated PR body/commit message contains NO issue-closing
 *       reference (guards against a chore/refactor that quietly also closes a
 *       bug report). If it does, the commit is skipped as ambiguous.
 *     - The stored hunk must be an ELIGIBLE SOURCE hunk (see below).
 *     - `label.defect = false`.
 *
 *   ELIGIBLE SOURCE HUNK (applies to BOTH sets — v2 change, see README §4):
 *     - File extension is exactly `.ts` (no `.tsx`, no `.d.ts`).
 *     - Path contains a `src` directory segment (e.g. `src/x.ts`,
 *       `packages/foo/src/x.ts`) — this is what keeps the benign set's file
 *       layout comparable to the defect set's instead of being dominated by
 *       docs/config files, which was the exact confound the model could
 *       "cheat" on in v1.
 *     - Path does NOT fall under any of: test/tests/__tests__/e2e directories,
 *       docs/.vitepress directories, dist/build/coverage/node_modules/
 *       __snapshots__/.changeset/vendor directories, OR match `*.test.ts`,
 *       `*.spec.ts`, `*.test-d.ts`, `*.config.*`, `tsconfig*`, `*.snap`,
 *       `*.lock`, `*.min.(ts|js)`, `*.generated.ts`, `*.md`,
 *       `package-lock.json` (see isEligibleSourcePath()).
 *     - 10-80 changed/context lines (`--unified=5` diff), see MIN/MAX_HUNK_LINES.
 *
 *   DETERMINISM: candidate commits are fetched via `git log --no-merges
 *   --date-order` and then explicitly re-sorted by commit date descending in
 *   this script (belt-and-suspenders — `--date-order` should already do this
 *   for a linear, squash-merged branch), so "take the first N eligible" is a
 *   stable, reproducible selection given the same repo state.
 *
 *   PER-REPO BALANCING: each BASE repo is capped at
 *   ceil(target / baseRepos.length) per label (so 50/4 repos → 13 max per
 *   repo per label), processed in `--repos` order; a FALLBACK repo list is
 *   only touched afterwards, uncapped, to top up any shortfall.
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
  dataset_version: number;
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

const DEFAULT_BASE_REPOS = ["colinhacks/zod", "vitest-dev/vitest", "honojs/hono", "trpc/trpc"];
const DEFAULT_FALLBACK_REPOS = ["fastify/fastify"];

const MIN_HUNK_LINES = 10;
const MAX_HUNK_LINES = 80;

// v2: directories excluded from BOTH sets (test, docs, config, generated, vendor).
const EXCLUDE_DIR_SEGMENTS = new Set([
  "dist",
  "build",
  "coverage",
  "node_modules",
  "__snapshots__",
  "__tests__",
  ".changeset",
  "vendor",
  "test",
  "tests",
  "e2e",
  "docs",
  ".vitepress",
]);

// v2: filenames excluded from BOTH sets, in addition to the directory rules above.
const EXCLUDE_FILE_RE =
  /(\.snap|\.lock|\.min\.(ts|js)|\.generated\.ts|\.d\.ts|\.test\.ts|\.spec\.ts|\.test-d\.ts|\.config\.[a-z0-9]+|\.md|package-lock\.json)$/i;
const TSCONFIG_RE = /^tsconfig(\..+)?\.(json|ts)$/i;

const FIX_SUBJECT_RE = /^fix(\([^)]*\))?!?:/i;
// v2: benign candidates are restricted to refactor/feat/chore/perf. docs/test
// commits are dropped — they essentially never touch an eligible source hunk
// (see isEligibleSourcePath) and were the main source of the v1 file-type
// confound (README.md §4).
const BENIGN_SUBJECT_RE = /^(refactor|feat|chore|perf)(\([^)]*\))?!?:/i;

// chore(deps): ... -> deps ; feat -> feature ; refactor/perf -> refactor ;
// chore(<anything else>) -> config
const CATEGORY_BY_TYPE: Record<string, Category> = {
  fix: "bugfix",
  feat: "feature",
  refactor: "refactor",
  perf: "refactor",
};

const ISSUE_CLOSE_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

const PUBLIC_API_PATH_RE = /(^|\/)(src\/)?index\.ts$|(^|\/)mod\.ts$/i;
const SECURITY_PATH_RE = /(auth|crypto|security|jwt|session|password|token|csrf|cors)/i;

// ---------------------------------------------------------------------------
// Path eligibility (v2 — shared by both DEFECT and BENIGN collection so the
// two sets have comparable file-path distributions; see README §4).
// ---------------------------------------------------------------------------

function isEligibleSourcePath(path: string): boolean {
  if (!path.endsWith(".ts")) return false;
  const segments = path.split("/");
  const base = segments.at(-1);
  if (base === undefined) return false; // path.split("/") on a non-empty string always has a last element; guard for the type checker.

  if (TSCONFIG_RE.test(base)) return false;
  if (EXCLUDE_FILE_RE.test(base)) return false;
  if (segments.some((s) => EXCLUDE_DIR_SEGMENTS.has(s.toLowerCase()))) return false;

  // Must live under a `src` directory somewhere in its path — this is what
  // keeps benign hunks in the same neighborhood (packages/*/src, src/...) as
  // defect hunks instead of drifting into docs/config-only territory.
  if (!segments.includes("src")) return false;

  return true;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
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

const repos = (typeof args.repos === "string" ? args.repos : DEFAULT_BASE_REPOS.join(","))
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const fallbackRepos = (
  typeof args["fallback-repos"] === "string"
    ? args["fallback-repos"]
    : DEFAULT_FALLBACK_REPOS.join(",")
)
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const targetDefect = Number(args["target-defect"] ?? 50);
const targetBenign = Number(args["target-benign"] ?? 50);
const outPath = typeof args.out === "string" ? args.out : join("datasets", "hunks.jsonl");
const maxScan = Number(args["max-scan"] ?? 600);
const datasetVersion = Number(args["dataset-version"] ?? 2);
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
    const path = headerMatch?.[2];
    if (path === undefined) continue; // no `b/<path>` capture — not a parseable file diff block

    if (/^(new file mode|deleted file mode|rename from|rename to)/m.test(block)) continue;
    if (/^Binary files /m.test(block)) continue;
    if (!isEligibleSourcePath(path)) continue;

    const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;
    const starts: { index: number; header: string }[] = [];
    let m: RegExpExecArray | null = hunkHeaderRe.exec(block);
    while (m !== null) {
      starts.push({ index: m.index, header: m[0] });
      m = hunkHeaderRe.exec(block);
    }

    for (let i = 0; i < starts.length; i++) {
      const current = starts[i];
      if (!current) continue; // i < starts.length always yields an element; guard for the type checker.
      const next = starts[i + 1];
      const start = current.index;
      const end = next ? next.index : block.length;
      const hunkBody = block.slice(start, end);
      const lines = hunkBody.split("\n").slice(1); // drop the @@ header line itself

      const before: string[] = [];
      const after: string[] = [];
      const diffLines: string[] = [current.header];
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
  date: string;
}

function listCandidateCommits(dir: string, subjectRe: RegExp, limit: number): CommitInfo[] {
  const raw = sh(
    "git",
    [
      "-C",
      dir,
      "log",
      "--no-merges",
      "--date-order",
      "-n",
      String(limit),
      "--pretty=format:%H%x1f%cI%x1f%s",
    ],
    dir,
  );
  const out: CommitInfo[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [sha, date, subject] = line.split("\x1f");
    if (!sha || !date || !subject) continue;
    const match = subject.match(subjectRe);
    if (!match) continue;
    const typeMatch = subject.match(/^([a-z]+)/i);
    out.push({ sha, date, subject, type: (typeMatch?.[1] ?? "").toLowerCase() });
  }
  // Explicit, deterministic ordering: newest commit first. `--date-order`
  // above should already guarantee this for a linear branch; this re-sort is
  // belt-and-suspenders so "take the first N eligible" is fully reproducible.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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
    dataset_version: datasetVersion,
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
      if (hunks.length === 0) continue; // no eligible source hunk in this commit — skip it (v2)

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
      if (hunks.length === 0) continue; // no eligible source hunk in this commit — skip it

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

function processRepo(
  repo: string,
  wantDefect: number,
  wantBenign: number,
): { defect: HunkRecord[]; benign: HunkRecord[] } {
  if (wantDefect <= 0 && wantBenign <= 0) return { defect: [], benign: [] };

  console.error(`\n=== ${repo} ===`);
  const license = repoLicense(repo);
  console.error(`  license: ${license}`);
  if (!/^(MIT|Apache-2\.0)$/i.test(license)) {
    console.error(`  SKIPPING ${repo}: license "${license}" is not MIT/Apache-2.0`);
    return { defect: [], benign: [] };
  }

  let dir: string;
  try {
    dir = cloneRepo(repo);
  } catch (err) {
    console.error(`  clone failed for ${repo}: ${(err as Error).message}`);
    return { defect: [], benign: [] };
  }

  try {
    const { defect, benign } = collectFromRepo(repo, dir, license, wantDefect, wantBenign);
    console.error(`  collected: ${defect.length} defect, ${benign.length} benign`);
    return { defect, benign };
  } finally {
    cleanupRepo(dir);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  console.error(`Base repos: ${repos.join(", ")}`);
  console.error(`Fallback repos: ${fallbackRepos.join(", ")}`);
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

  const perRepoDefectCap = Math.ceil(targetDefect / repos.length);
  const perRepoBenignCap = Math.ceil(targetBenign / repos.length);

  function persist(defect: HunkRecord[], benign: HunkRecord[]) {
    allDefect.push(...defect);
    allBenign.push(...benign);
    for (const rec of [...defect, ...benign]) {
      appendFileSync(outPath, `${JSON.stringify(rec)}\n`);
    }
  }

  // Pass 1: base repos, evenly capped, so no single repo dominates the set.
  for (const repo of repos) {
    const remainingDefect = Math.max(0, targetDefect - allDefect.length);
    const remainingBenign = Math.max(0, targetBenign - allBenign.length);
    const wantDefect = Math.min(perRepoDefectCap, remainingDefect);
    const wantBenign = Math.min(perRepoBenignCap, remainingBenign);
    const { defect, benign } = processRepo(repo, wantDefect, wantBenign);
    persist(defect, benign);
  }

  // Pass 2: fallback repos, uncapped, only to top up a shortfall.
  if (allDefect.length < targetDefect || allBenign.length < targetBenign) {
    for (const repo of fallbackRepos) {
      if (allDefect.length >= targetDefect && allBenign.length >= targetBenign) break;
      const remainingDefect = Math.max(0, targetDefect - allDefect.length);
      const remainingBenign = Math.max(0, targetBenign - allBenign.length);
      const { defect, benign } = processRepo(repo, remainingDefect, remainingBenign);
      persist(defect, benign);
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
      `WARNING: fell short of targets (wanted ${targetDefect}/${targetBenign}). Add more repos with --repos/--fallback-repos or raise --max-scan.`,
    );
  }
}

main();
