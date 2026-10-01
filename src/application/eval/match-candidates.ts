/**
 * Matches a case's candidate findings to its golden issues: the
 * deterministic shortlist (./prefilter.ts `shortlistIssues`: every issue of
 * the candidate's file plus the top cross-file ones by word overlap)
 * narrows the issues, then the {@link FindingMatcherPort} picks one of them
 * or none. A candidate whose shortlist is empty is unmatched without a
 * matcher call; an answer outside the shortlist is treated as "none".
 */
import type {
  FindingMatcherPort,
  MatchCandidate,
  MatchableIssue,
} from "../../domain/ports/finding-matcher-port.js";
import type { CandidateFinding } from "./candidate.js";
import type { GoldenIssue } from "./golden-set.js";
import { prefilterIssues, shortlistIssues } from "./prefilter.js";

export interface MatchedCandidate extends CandidateFinding {
  /** The golden issue this candidate is about, or `null` (unlabeled). */
  readonly issueId: string | null;
}

export interface MatchCandidatesInput {
  readonly issues: readonly GoldenIssue[];
  readonly candidates: readonly CandidateFinding[];
  readonly matcher: FindingMatcherPort;
  /** Matcher calls in flight at once. Default 1. */
  readonly concurrency?: number;
}

export interface MatchCandidatesResult {
  readonly matched: MatchedCandidate[];
  /** Matcher decisions asked for (cache hits included). */
  readonly matcherCalls: number;
  readonly cacheHits: number;
  readonly matcherCostUsd: number;
}

export async function matchCandidates(input: MatchCandidatesInput): Promise<MatchCandidatesResult> {
  const matched: MatchedCandidate[] = new Array(input.candidates.length);
  let matcherCalls = 0;
  let cacheHits = 0;
  let matcherCostUsd = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < input.candidates.length) {
      const index = next++;
      const candidate = input.candidates[index] as CandidateFinding;
      const target = toMatchCandidate(candidate);
      const shortlist = shortlistIssues(input.issues, target);
      if (shortlist.length === 0) {
        matched[index] = { ...candidate, issueId: null };
        continue;
      }
      const decision = await input.matcher.match({
        goldenIssues: shortlist.map(toMatchableIssue),
        candidate: target,
      });
      matcherCalls++;
      if (decision.cached) cacheHits++;
      matcherCostUsd += decision.costUsd;
      const valid = shortlist.some((issue) => issue.id === decision.issueId);
      matched[index] = { ...candidate, issueId: valid ? decision.issueId : null };
    }
  }

  const workers = Math.max(1, Math.min(input.concurrency ?? 1, input.candidates.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { matched, matcherCalls, cacheHits, matcherCostUsd };
}

function toMatchCandidate(candidate: CandidateFinding): MatchCandidate {
  return {
    file: candidate.file,
    line: candidate.line,
    text: candidate.text,
    ...(candidate.claim !== undefined ? { claim: candidate.claim } : {}),
    ...(candidate.failingScenario !== undefined
      ? { failingScenario: candidate.failingScenario }
      : {}),
    ...(candidate.evidence !== undefined && candidate.evidence.length > 0
      ? { evidence: candidate.evidence }
      : {}),
  };
}

function toMatchableIssue(issue: GoldenIssue): MatchableIssue {
  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    ...(issue.locations !== undefined && issue.locations.length > 0
      ? { locations: issue.locations }
      : {}),
    title: issue.title,
    ...(issue.category !== undefined ? { category: issue.category } : {}),
    verdict: issue.verdict,
    ...(issue.notes !== undefined ? { notes: issue.notes } : {}),
  };
}

/**
 * Deterministic, free matcher: the strict pre-filter's first (closest)
 * issue among those offered (the wider LLM shortlist would over-match even
 * more). Over-matches on purpose; for dry runs and smoke tests, never for
 * numbers you report.
 */
export function createTopPrefilterMatcher(): FindingMatcherPort {
  return {
    async match(input) {
      const [closest] = prefilterIssues(input.goldenIssues, input.candidate);
      return { issueId: closest?.id ?? null, costUsd: 0 };
    },
  };
}
