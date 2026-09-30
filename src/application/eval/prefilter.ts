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
import type { GoldenIssue, GoldenLocation } from "./golden-set.js";

export const PREFILTER_LINE_WINDOW = 15;
export const PREFILTER_SAME_FILE_COVERAGE = 0.3;
export const PREFILTER_TITLE_ONLY_COVERAGE = 0.4;
export const PREFILTER_ANY_FILE_COVERAGE = 0.6;
export const PREFILTER_MAX_ISSUES = 8;

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

export function issueLocations(issue: GoldenIssue): GoldenLocation[] {
  const locations: GoldenLocation[] = [];
  if (issue.file !== null) locations.push({ file: issue.file, line: issue.line ?? 0 });
  for (const location of issue.locations ?? []) locations.push(location);
  return locations;
}

interface Scored {
  readonly issue: GoldenIssue;
  /** Smallest line distance among same-file locations; Infinity when none. */
  readonly distance: number;
  readonly coverage: number;
}

function score(issue: GoldenIssue, candidate: MatchCandidate): Scored | null {
  const coverage = titleCoverage(issue.title, candidate.text);
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
  const keep =
    (inSameFile &&
      (distance <= PREFILTER_LINE_WINDOW || coverage >= PREFILTER_SAME_FILE_COVERAGE)) ||
    coverage >= PREFILTER_ANY_FILE_COVERAGE ||
    ((locations.length === 0 || candidate.file === null) &&
      coverage >= PREFILTER_TITLE_ONLY_COVERAGE);
  return keep ? { issue, distance, coverage } : null;
}

/** The issues `candidate` could be about, closest first, at most `max`. */
export function prefilterIssues(
  issues: readonly GoldenIssue[],
  candidate: MatchCandidate,
  max = PREFILTER_MAX_ISSUES,
): GoldenIssue[] {
  return issues
    .map((issue) => score(issue, candidate))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => a.distance - b.distance || b.coverage - a.coverage)
    .slice(0, max)
    .map((s) => s.issue);
}
