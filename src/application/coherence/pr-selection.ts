/**
 * Pure selection logic for the H7 intent–change coherence dataset
 * (`datasets/prs.jsonl` + `datasets/coherence-pairs.jsonl`). Three concerns
 * live here, all side-effect free so they can be unit tested without GitHub:
 *
 * 1. `stripPrTemplate` — a PR body as GitHub returns it is mostly template
 *    noise (HTML comments, unchecked checklists, empty "## Description"
 *    headings). If we counted that as "description", a 20-character PR
 *    would pass the length gate on boilerplate alone, and Jev would be
 *    asked to judge coherence against a checklist. Strip first, measure
 *    after.
 * 2. `isEligiblePr` — the gate that decides which merged PRs are worth
 *    storing. Rules are deliberately conservative (small, human-authored,
 *    well-described, at least one non-docs file, no secrets) so that the
 *    "coherent" label is trustworthy: an eligible PR's own description is
 *    assumed to describe its change. The `files` field is optional so the
 *    collector can run the cheap metadata checks BEFORE paying a
 *    `pulls.listFiles` call per candidate.
 * 3. `generateCoherencePairs` — the crossed-description protocol. For every
 *    PR we emit a coherent pair (its own description) and an incoherent
 *    pair (the description of another PR from the SAME repo). The foreign
 *    description is assigned by a seeded Sattolo cycle per repo: a single
 *    n-cycle has no fixed points by construction, so no PR ever gets its own
 *    description, and every description is used exactly once as a foreign
 *    one. Same-repo crossing matters: a zod description on a hono diff would
 *    be trivially incoherent from vocabulary alone.
 *
 * `countBasenameLeaks` and `describeDistribution` are reporting helpers the
 * collector prints and the README quotes; they are here (not in the script)
 * so the numbers are reproducible under test.
 */
import { containsSecret } from "../../domain/redact.js";
import { hashString, mulberry32 } from "../spike/prng.js";
import type { CoherencePair, PrFile, PrRecord } from "./pr-record.js";

export const MIN_BODY_LENGTH = 200;
export const MIN_FILES = 1;
export const MAX_FILES = 12;
export const MAX_CHANGED_LINES = 500;

export type RejectionReason =
  | "not-merged"
  | "bot-author"
  | "short-body"
  | "file-count"
  | "too-many-changed-lines"
  | "no-source-file"
  | "secret";

export interface PrCandidate {
  readonly merged: boolean;
  readonly author: string;
  readonly title: string;
  /** Raw body as returned by GitHub; stripped internally before measuring. */
  readonly body: string;
  /** Omit to run only the cheap metadata checks (before fetching files). */
  readonly files?: readonly PrFile[];
}

export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: RejectionReason };

// ---------------------------------------------------------------------------
// Template stripping
// ---------------------------------------------------------------------------

/** A comment that owns its whole line(s) goes together with its line break, so it leaves no blank line behind. */
const HTML_COMMENT_LINE_RE = /^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const CHECKLIST_LINE_RE = /^\s*[-*+]\s+\[[ xX]\]\s.*$/gm;
const HEADING_RE = /^#{1,6}\s+\S/;

/** Drops any markdown heading whose section (up to the next heading or EOF) is blank. */
function dropEmptyHeadings(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!HEADING_RE.test(line)) {
      out.push(line);
      continue;
    }
    let j = i + 1;
    let hasContent = false;
    while (j < lines.length && !HEADING_RE.test(lines[j] ?? "")) {
      if ((lines[j] ?? "").trim() !== "") {
        hasContent = true;
        break;
      }
      j++;
    }
    if (hasContent) {
      out.push(line);
    } else {
      // Skip the heading and its blank section.
      i = j - 1;
    }
  }
  return out.join("\n");
}

export function stripPrTemplate(body: string): string {
  const withoutComments = body
    .replace(/\r\n/g, "\n")
    .replace(HTML_COMMENT_LINE_RE, "")
    .replace(HTML_COMMENT_RE, "");
  const withoutChecklists = withoutComments.replace(CHECKLIST_LINE_RE, "");
  const withoutEmptyHeadings = dropEmptyHeadings(withoutChecklists);
  return withoutEmptyHeadings
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const BOT_LOGINS = new Set(["dependabot", "renovate", "github-actions"]);
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]);

export function isBotAuthor(login: string): boolean {
  const lower = login.toLowerCase();
  return lower.endsWith("[bot]") || BOT_LOGINS.has(lower);
}

/** True for docs, lockfiles and changesets: files that say nothing about the intent of a code change. */
export function isNonSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1) ?? lower;
  if (base.endsWith(".md") || base.endsWith(".mdx")) return true;
  if (segments.includes("docs")) return true;
  if (LOCKFILES.has(base)) return true;
  if (segments.includes(".changeset")) return true;
  return false;
}

export function isEligiblePr(candidate: PrCandidate): EligibilityResult {
  if (!candidate.merged) return { eligible: false, reason: "not-merged" };
  if (isBotAuthor(candidate.author)) return { eligible: false, reason: "bot-author" };
  if (stripPrTemplate(candidate.body).length < MIN_BODY_LENGTH) {
    return { eligible: false, reason: "short-body" };
  }
  if (containsSecret(candidate.title) || containsSecret(candidate.body)) {
    return { eligible: false, reason: "secret" };
  }
  const files = candidate.files;
  if (files === undefined) return { eligible: true };

  if (files.length < MIN_FILES || files.length > MAX_FILES) {
    return { eligible: false, reason: "file-count" };
  }
  const changed = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (changed > MAX_CHANGED_LINES) return { eligible: false, reason: "too-many-changed-lines" };
  if (!files.some((f) => !isNonSourceFile(f.path))) {
    return { eligible: false, reason: "no-source-file" };
  }
  if (files.some((f) => f.patch !== undefined && containsSecret(f.patch))) {
    return { eligible: false, reason: "secret" };
  }
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Crossed-description pairs
// ---------------------------------------------------------------------------

/**
 * Sattolo's algorithm: like Fisher–Yates but each element is swapped with a
 * strictly earlier position, which yields a uniformly random single n-cycle.
 * A single cycle over n >= 2 elements has no fixed points, which is exactly
 * the derangement guarantee the incoherent pairs need.
 */
function sattoloCycle(n: number, rng: () => number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * i);
    const a = perm[i];
    const b = perm[j];
    if (a === undefined || b === undefined) throw new Error("unreachable: index inside range");
    perm[i] = b;
    perm[j] = a;
  }
  return perm;
}

export function generateCoherencePairs(
  records: readonly PrRecord[],
  seed: number,
): CoherencePair[] {
  const byRepo = new Map<string, PrRecord[]>();
  for (const r of records) {
    const bucket = byRepo.get(r.repo);
    if (bucket) bucket.push(r);
    else byRepo.set(r.repo, [r]);
  }

  const foreignFor = new Map<string, string>();
  for (const [repo, group] of byRepo) {
    if (group.length < 2) {
      throw new Error(
        `repo ${repo} has ${group.length} PR(s); at least 2 are needed to cross descriptions`,
      );
    }
    const rng = mulberry32((seed ^ hashString(repo)) >>> 0);
    const perm = sattoloCycle(group.length, rng);
    for (const [index, pr] of group.entries()) {
      const target = perm[index];
      const donor = target === undefined ? undefined : group[target];
      if (donor === undefined) throw new Error("unreachable: permutation index inside group");
      foreignFor.set(pr.id, donor.id);
    }
  }

  const pairs: CoherencePair[] = [];
  for (const r of records) {
    const foreign = foreignFor.get(r.id);
    if (foreign === undefined) throw new Error(`unreachable: no foreign description for ${r.id}`);
    pairs.push({ prId: r.id, descriptionPrId: r.id, label: "coherent" });
    pairs.push({ prId: r.id, descriptionPrId: foreign, label: "incoherent" });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

/**
 * How many incoherent pairs have a foreign description that mentions, verbatim,
 * the basename of at least one file in the change. Such a pair is a potential
 * label leak (the "wrong" description still names the right file). Reported,
 * not filtered: see datasets/README.md.
 */
export function countBasenameLeaks(
  records: readonly PrRecord[],
  pairs: readonly CoherencePair[],
): number {
  const byId = new Map(records.map((r) => [r.id, r]));
  let leaks = 0;
  for (const pair of pairs) {
    if (pair.label !== "incoherent") continue;
    const change = byId.get(pair.prId);
    const description = byId.get(pair.descriptionPrId);
    if (!change || !description) continue;
    const text = `${description.title}\n${description.body}`;
    const mentioned = change.files.some((f) => {
      const base = f.path.split("/").at(-1);
      return base !== undefined && base !== "" && text.includes(base);
    });
    if (mentioned) leaks++;
  }
  return leaks;
}

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
}

/** Nearest-rank percentiles over a numeric sample. */
export function describeDistribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, min: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1] ?? 0;
  };
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p25: at(25),
    p50: at(50),
    p75: at(75),
    p90: at(90),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
