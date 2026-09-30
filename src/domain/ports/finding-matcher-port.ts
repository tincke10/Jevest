/**
 * Port for the eval harness's matcher (docs/EVAL.md): decides which golden
 * issue, if any, a candidate review finding is about. The caller has
 * already narrowed `goldenIssues` with a cheap deterministic pre-filter
 * (src/application/eval/prefilter.ts); the matcher picks one of them or
 * none. Zero SDK imports: adapters implement it.
 */

export interface MatchableIssue {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly title: string;
  /** Adjudicator evidence, if any; helps an LLM matcher tell two close issues apart. */
  readonly notes?: string;
}

export interface MatchCandidate {
  readonly file: string | null;
  readonly line: number | null;
  /** The finding as the review showed it (claim, question, narrative point). */
  readonly text: string;
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
}

export interface FindingMatcherPort {
  match(input: FindingMatchInput): Promise<FindingMatch>;
}
