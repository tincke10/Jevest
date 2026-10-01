/**
 * The matcher's cheap deterministic pre-filter (docs/EVAL.md "Matching"):
 * which golden issues a candidate finding COULD be about, so the LLM
 * matcher only ever chooses among a handful and most candidates never need
 * a call at all. Recall-oriented on purpose: a wrong keep costs one LLM
 * decision, a wrong drop turns a hit into an "unlabeled" finding.
 *
 * An issue is kept when any of its locations (its `file`/`line` plus
 * `locations`) is in the candidate's file and
 *
 * - within {@link PREFILTER_LINE_WINDOW} lines, or
 * - the issue title's words are covered by the candidate text at least
 *   {@link PREFILTER_SAME_FILE_COVERAGE};
 *
 * or, whatever the file, when the coverage is at least
 * {@link PREFILTER_ANY_FILE_COVERAGE} (a reviewer may pin an issue on its
 * caller); or, when the issue has no location or the candidate has no file
 * (a narrative point), at least {@link PREFILTER_TITLE_ONLY_COVERAGE}.
 */
import type { MatchCandidate } from "../../domain/ports/finding-matcher-port.js";
import type { GoldenLocation } from "./golden-set.js";

export const PREFILTER_LINE_WINDOW = 15;
export const PREFILTER_SAME_FILE_COVERAGE = 0.3;
export const PREFILTER_TITLE_ONLY_COVERAGE = 0.4;
export const PREFILTER_ANY_FILE_COVERAGE = 0.6;
export const PREFILTER_MAX_ISSUES = 8;
export const SHORTLIST_MAX_ISSUES = 12;
export const SHORTLIST_CROSS_FILE_TOP = 3;
/** A cross-file issue needs at least this share of its title words in the candidate. */
export const SHORTLIST_CROSS_FILE_MIN_COVERAGE = 0.25;

/** What the pre-filters read of an issue (a GoldenIssue, or a MatchableIssue the matcher was offered). */
export interface PrefilterIssue {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly locations?: readonly GoldenLocation[];
  readonly title: string;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "not",
  "are",
  "was",
  "but",
  "can",
  "when",
  "then",
  "than",
  "its",
  "has",
  "have",
  "only",
  "also",
  "does",
  "any",
  "all",
  "now",
  "still",
  "which",
  "while",
]);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Lowercased, camelCase-split, stemmed words of 3+ letters, without stopwords. */
export function tokenize(text: string): Set<string> {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
  return new Set(words);
}

/** Share (0..1) of the issue title's words that appear in the candidate text. */
export function titleCoverage(issueTitle: string, candidateText: string): number {
  const title = tokenize(issueTitle);
  if (title.size === 0) return 0;
  const candidate = tokenize(candidateText);
  let hits = 0;
  for (const word of title) if (candidate.has(word)) hits++;
  return hits / title.size;
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Equal paths, one a suffix of the other, or the same base name (reviewers shorten paths). */
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return baseName(a) === baseName(b);
}

export function issueLocations(issue: PrefilterIssue): GoldenLocation[] {
  const locations: GoldenLocation[] = [];
  if (issue.file !== null) locations.push({ file: issue.file, line: issue.line ?? 0 });
  for (const location of issue.locations ?? []) locations.push(location);
  return locations;
}

interface Scored<T extends PrefilterIssue> {
  readonly issue: T;
  readonly inSameFile: boolean;
  /** Smallest line distance among same-file locations; Infinity when none. */
  readonly distance: number;
  readonly coverage: number;
}

function measure<T extends PrefilterIssue>(issue: T, candidate: MatchCandidate): Scored<T> {
  const coverage = titleCoverage(issue.title, candidateWords(candidate));
  const locations = issueLocations(issue);
  let distance = Number.POSITIVE_INFINITY;
  let inSameFile = false;
  if (candidate.file !== null) {
    for (const location of locations) {
      if (!sameFile(candidate.file, location.file)) continue;
      inSameFile = true;
      if (candidate.line !== null && location.line > 0) {
        distance = Math.min(distance, Math.abs(candidate.line - location.line));
      }
    }
  }
  return { issue, inSameFile, distance, coverage };
}

/** The candidate's text plus its separate claim and failing scenario, when present. */
function candidateWords(candidate: MatchCandidate): string {
  return [candidate.text, candidate.claim, candidate.failingScenario]
    .filter((t): t is string => t !== undefined)
    .join(" ");
}

function score<T extends PrefilterIssue>(issue: T, candidate: MatchCandidate): Scored<T> | null {
  const scored = measure(issue, candidate);
  const { inSameFile, distance, coverage } = scored;
  const locations = issueLocations(issue);
  const keep =
    (inSameFile &&
      (distance <= PREFILTER_LINE_WINDOW || coverage >= PREFILTER_SAME_FILE_COVERAGE)) ||
    coverage >= PREFILTER_ANY_FILE_COVERAGE ||
    ((locations.length === 0 || candidate.file === null) &&
      coverage >= PREFILTER_TITLE_ONLY_COVERAGE);
  return keep ? scored : null;
}

function closestFirst<T extends PrefilterIssue>(a: Scored<T>, b: Scored<T>): number {
  return a.distance - b.distance || b.coverage - a.coverage;
}

/** The issues `candidate` could be about, closest first, at most `max` (the strict filter). */
export function prefilterIssues<T extends PrefilterIssue>(
  issues: readonly T[],
  candidate: MatchCandidate,
  max = PREFILTER_MAX_ISSUES,
): T[] {
  return issues
    .map((issue) => score(issue, candidate))
    .filter((s): s is Scored<T> => s !== null)
    .sort(closestFirst)
    .slice(0, max)
    .map((s) => s.issue);
}

/**
 * The issues offered to the LLM matcher: all of the candidate's file
 * (closest first), then the top cross-file ones by title-word overlap; at
 * most `max`, keeping room for the cross-file ones.
 */
export function shortlistIssues<T extends PrefilterIssue>(
  issues: readonly T[],
  candidate: MatchCandidate,
  max = SHORTLIST_MAX_ISSUES,
): T[] {
  const scored = issues.map((issue) => measure(issue, candidate));
  const cross = scored
    .filter((s) => !s.inSameFile && s.coverage >= SHORTLIST_CROSS_FILE_MIN_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, Math.min(SHORTLIST_CROSS_FILE_TOP, max));
  const same = scored
    .filter((s) => s.inSameFile)
    .sort(closestFirst)
    .slice(0, max - cross.length);
  return [...same, ...cross].map((s) => s.issue);
}
