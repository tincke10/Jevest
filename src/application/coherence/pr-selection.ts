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
 *    pair (the description of another PR from the SAME repo). Two crossing
 *    strategies, selected per call:
 *      - `"random"` (default): the foreign description is assigned by a
 *        seeded Sattolo cycle per repo — a single n-cycle has no fixed
 *        points by construction, so no PR ever gets its own description,
 *        and every description is used exactly once as a foreign one. This
 *        is an EASY negative: the crossed description is usually about a
 *        different area entirely.
 *      - `"hard"`: the foreign description comes from the most similar
 *        same-repo PR by change footprint (Jaccard over touched
 *        directories, tie-broken by file-kind distribution then by title
 *        token overlap), excluding itself. A description can be reused by
 *        up to 2 PRs — with ~25 PRs per repo, a strict derangement under
 *        "most similar" is not always achievable, so reuse is capped and
 *        the assignment falls back to the next most similar donor. This is
 *        a near-duplicate negative: the crossed description is plausible
 *        for the change's neighborhood, just not for the change itself.
 *    Same-repo crossing matters either way: a zod description on a hono
 *    diff would be trivially incoherent from vocabulary alone.
 *
 * `countBasenameLeaks` and `describeDistribution` are reporting helpers the
 * collector prints and the README quotes; they are here (not in the script)
 * so the numbers are reproducible under test.
 */
import { containsSecret } from "../../domain/redact.js";
import { hashString, mulberry32 } from "../spike/prng.js";
import { FILE_KINDS, type FileKind, classifyFileKind } from "./change-facts.js";
import type { CoherenceCrossingStrategy, CoherencePair, PrFile, PrRecord } from "./pr-record.js";

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

// ---------------------------------------------------------------------------
// "hard" strategy: most-similar-by-footprint crossing
// ---------------------------------------------------------------------------

/** Cap on how many PRs may share the same foreign-description donor under the "hard" strategy. */
export const MAX_HARD_DONOR_REUSE = 2;

/** Every ancestor directory of every file's path, basename removed, all depths. Root-level files contribute nothing. */
function touchedDirectories(files: readonly PrFile[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // drop the basename
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      dirs.add(acc);
    }
  }
  return dirs;
}

/** Jaccard similarity of two sets; 0 for two empty sets (no shared signal, not "identical"). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Normalized (sums to 1) distribution of `classifyFileKind` over a PR's files. */
function kindDistribution(files: readonly PrFile[]): Map<FileKind, number> {
  const dist = new Map<FileKind, number>();
  if (files.length === 0) return dist;
  for (const f of files) {
    const kind = classifyFileKind(f.path);
    dist.set(kind, (dist.get(kind) ?? 0) + 1);
  }
  for (const [kind, count] of dist) dist.set(kind, count / files.length);
  return dist;
}

/** Histogram intersection of two normalized kind distributions; in [0, 1], 1 iff identical. */
function kindOverlap(a: ReadonlyMap<FileKind, number>, b: ReadonlyMap<FileKind, number>): number {
  let overlap = 0;
  for (const kind of FILE_KINDS) overlap += Math.min(a.get(kind) ?? 0, b.get(kind) ?? 0);
  return overlap;
}

/** Lowercased word tokens of a title, template noise stripped first (harmless no-op on most titles). */
function titleTokens(title: string): Set<string> {
  const tokens = stripPrTemplate(title)
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return new Set(tokens ?? []);
}

/** Deterministic pseudo-random tiebreak for one ordered (pr, candidate) pair, given a global seed. */
function seededTiebreak(seed: number, prId: string, candidateId: string): number {
  const rng = mulberry32((seed ^ hashString(`${prId}|${candidateId}`)) >>> 0);
  return rng();
}

interface HardCandidateScore {
  readonly candidate: PrRecord;
  readonly dirJaccard: number;
  readonly kindOverlap: number;
  readonly titleOverlap: number;
  readonly tiebreak: number;
}

/**
 * Ranks every OTHER PR in `group` as a foreign-description candidate for
 * each PR in it, best (most similar) first: primarily by Jaccard over
 * touched directories, then by file-kind distribution overlap, then by
 * title token overlap, then by a seeded deterministic tiebreak. `sort` is
 * stable, so the seed is the only source of ordering among exact ties.
 */
function rankHardCandidates(
  group: readonly PrRecord[],
  seed: number,
): Map<string, HardCandidateScore[]> {
  const dirsById = new Map(group.map((r) => [r.id, touchedDirectories(r.files)] as const));
  const kindsById = new Map(group.map((r) => [r.id, kindDistribution(r.files)] as const));
  const titlesById = new Map(group.map((r) => [r.id, titleTokens(r.title)] as const));

  const rankedByPr = new Map<string, HardCandidateScore[]>();
  for (const pr of group) {
    const prDirs = dirsById.get(pr.id) ?? new Set<string>();
    const prKinds = kindsById.get(pr.id) ?? new Map<FileKind, number>();
    const prTitle = titlesById.get(pr.id) ?? new Set<string>();

    const scored: HardCandidateScore[] = group
      .filter((other) => other.id !== pr.id)
      .map((candidate) => ({
        candidate,
        dirJaccard: jaccard(prDirs, dirsById.get(candidate.id) ?? new Set()),
        kindOverlap: kindOverlap(prKinds, kindsById.get(candidate.id) ?? new Map()),
        titleOverlap: jaccard(prTitle, titlesById.get(candidate.id) ?? new Set()),
        tiebreak: seededTiebreak(seed, pr.id, candidate.id),
      }));

    scored.sort((a, b) => {
      if (b.dirJaccard !== a.dirJaccard) return b.dirJaccard - a.dirJaccard;
      if (b.kindOverlap !== a.kindOverlap) return b.kindOverlap - a.kindOverlap;
      if (b.titleOverlap !== a.titleOverlap) return b.titleOverlap - a.titleOverlap;
      return b.tiebreak - a.tiebreak;
    });
    rankedByPr.set(pr.id, scored);
  }
  return rankedByPr;
}

interface HardCrossingAssignment {
  readonly donorPr: string;
  readonly similarity: number;
}

/**
 * Greedily assigns each PR in `group` its most similar other PR as a
 * foreign-description donor, capped at {@link MAX_HARD_DONOR_REUSE} uses per
 * donor. Feasible by construction: each PR has `group.length - 1`
 * candidates with total capacity `2 * (group.length - 1)`, which is always
 * >= `group.length` for group.length >= 2, so a donor with spare capacity
 * always exists regardless of processing order.
 */
function assignHardCrossing(
  group: readonly PrRecord[],
  seed: number,
): Map<string, HardCrossingAssignment> {
  const rankedByPr = rankHardCandidates(group, seed);
  const usage = new Map<string, number>();
  const assignment = new Map<string, HardCrossingAssignment>();

  for (const pr of group) {
    const ranked = rankedByPr.get(pr.id) ?? [];
    const pick = ranked.find((s) => (usage.get(s.candidate.id) ?? 0) < MAX_HARD_DONOR_REUSE);
    if (pick === undefined) {
      throw new Error(
        `unreachable: no donor with spare capacity for ${pr.id} (cap ${MAX_HARD_DONOR_REUSE})`,
      );
    }
    usage.set(pick.candidate.id, (usage.get(pick.candidate.id) ?? 0) + 1);
    assignment.set(pr.id, { donorPr: pick.candidate.id, similarity: pick.dirJaccard });
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Pair generation
// ---------------------------------------------------------------------------

export function generateCoherencePairs(
  records: readonly PrRecord[],
  seed: number,
  strategy: CoherenceCrossingStrategy = "random",
): CoherencePair[] {
  const byRepo = new Map<string, PrRecord[]>();
  for (const r of records) {
    const bucket = byRepo.get(r.repo);
    if (bucket) bucket.push(r);
    else byRepo.set(r.repo, [r]);
  }

  const foreignFor = new Map<string, string>();
  const crossingFor = new Map<
    string,
    { strategy: CoherenceCrossingStrategy; similarity: number }
  >();

  for (const [repo, group] of byRepo) {
    if (group.length < 2) {
      throw new Error(
        `repo ${repo} has ${group.length} PR(s); at least 2 are needed to cross descriptions`,
      );
    }

    if (strategy === "random") {
      const rng = mulberry32((seed ^ hashString(repo)) >>> 0);
      const perm = sattoloCycle(group.length, rng);
      for (const [index, pr] of group.entries()) {
        const target = perm[index];
        const donor = target === undefined ? undefined : group[target];
        if (donor === undefined) throw new Error("unreachable: permutation index inside group");
        foreignFor.set(pr.id, donor.id);
      }
    } else {
      const assignment = assignHardCrossing(group, seed);
      for (const pr of group) {
        const picked = assignment.get(pr.id);
        if (picked === undefined) throw new Error(`unreachable: no donor assigned for ${pr.id}`);
        foreignFor.set(pr.id, picked.donorPr);
        crossingFor.set(pr.id, { strategy, similarity: picked.similarity });
      }
    }
  }

  const pairs: CoherencePair[] = [];
  for (const r of records) {
    const foreign = foreignFor.get(r.id);
    if (foreign === undefined) throw new Error(`unreachable: no foreign description for ${r.id}`);
    pairs.push({ prId: r.id, descriptionPrId: r.id, label: "coherent" });
    const crossing = crossingFor.get(r.id);
    pairs.push({
      prId: r.id,
      descriptionPrId: foreign,
      label: "incoherent",
      ...(crossing !== undefined
        ? {
            crossing: {
              strategy: crossing.strategy,
              similarity: crossing.similarity,
              donorPr: foreign,
            },
          }
        : {}),
    });
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
