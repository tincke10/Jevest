/**
 * Port for the eval harness's matcher (docs/EVAL.md): decides which golden
 * issue, if any, a candidate review finding is about. The caller has
 * already narrowed `goldenIssues` with a cheap deterministic pre-filter
 * (src/application/eval/prefilter.ts); the matcher picks one of them or
 * none. Zero SDK imports: adapters implement it.
 */

export interface MatchLocation {
  readonly file: string;
  readonly line: number;
}

export interface MatchableIssue {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  /** Other places the issue shows up (the caller, the broken test, …). */
  readonly locations?: readonly MatchLocation[];
  readonly title: string;
  readonly category?: string;
  /** The adjudicator's verdict (real, partly, false, unverifiable). */
  readonly verdict?: string;
  /** Adjudicator evidence, if any; helps an LLM matcher tell two close issues apart. */
  readonly notes?: string;
}

export interface MatchEvidence {
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

export interface MatchCandidate {
  readonly file: string | null;
  readonly line: number | null;
  /** The finding as the review showed it (claim, question, narrative point). */
  readonly text: string;
  /** The bare claim, when the source keeps it apart from `text`. */
  readonly claim?: string;
  /** How the defect shows (agentic findings). */
  readonly failingScenario?: string;
  /** The reviewer's quotes from the code. */
  readonly evidence?: readonly MatchEvidence[];
}

export interface FindingMatchInput {
  readonly goldenIssues: readonly MatchableIssue[];
  readonly candidate: MatchCandidate;
}

export interface FindingMatch {
  /** One of `goldenIssues[].id`, or `null` for "none of them". */
  readonly issueId: string | null;
  /** What this decision cost (nominal for subscription-billed adapters); 0 for a cache hit or a deterministic matcher. */
  readonly costUsd: number;
  /** True when the decision came from the on-disk cache. */
  readonly cached?: boolean;
  /** The matcher's one-sentence reason, when it gives one (kept in the cache for audits). */
  readonly reason?: string;
}

export interface FindingMatcherPort {
  match(input: FindingMatchInput): Promise<FindingMatch>;
}
