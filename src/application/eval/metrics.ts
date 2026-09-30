/**
 * Eval metrics (docs/EVAL.md "Metrics"), pure: per case and in total, for
 * two views of a run — `shown` (what the author sees) and `all` (shown +
 * low, i.e. what the pipeline found at all).
 *
 * - Recall targets are `real` and `partly` issues. Unweighted recall is
 *   found / total; weighted recall weights each issue by
 *   {@link VERDICT_WEIGHTS} × {@link SEVERITY_WEIGHTS}.
 * - `realBySeverity`: `real` issues only, found / total per severity.
 * - `knownFalse`: candidates matched to a `false` issue (known noise).
 *   `unverifiable` matches are counted apart and in neither.
 * - `unlabeled`: candidates matched to no issue — label them to grow the set.
 * - `precisionLowerBound`: candidates matched to a target / candidates. A
 *   lower bound because unlabeled candidates may turn out real.
 *
 * Totals are micro averages: counts are summed across cases and the
 * ratios recomputed, so a case with many issues weighs more.
 */
import { GOLDEN_SEVERITIES, type GoldenIssue, type GoldenSeverity } from "./golden-set.js";
import type { MatchedCandidate } from "./match-candidates.js";

export const VERDICT_WEIGHTS = { real: 1, partly: 0.5 } as const;
export const SEVERITY_WEIGHTS: Readonly<Record<GoldenSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export type EvalView = "shown" | "all";

export interface FoundOfTotal {
  readonly found: number;
  readonly total: number;
}

export interface ViewMetrics {
  readonly candidates: number;
  readonly targets: number;
  readonly targetsFound: number;
  readonly recall: number | null;
  readonly weightedTotal: number;
  readonly weightedFound: number;
  readonly weightedRecall: number | null;
  readonly realBySeverity: Readonly<Record<GoldenSeverity, FoundOfTotal>>;
  /** Candidates matched to a real/partly issue (duplicates count). */
  readonly matchedTargets: number;
  readonly knownFalse: number;
  readonly unverifiable: number;
  readonly unlabeled: number;
  readonly precisionLowerBound: number | null;
}

export interface CaseMetrics {
  readonly caseId: string;
  readonly shown: ViewMetrics;
  readonly all: ViewMetrics;
  readonly costUsd: number | null;
  readonly tokens: number | null;
  readonly wallTimeMs: number | null;
}

export interface TotalMetrics {
  readonly cases: number;
  readonly shown: ViewMetrics;
  readonly all: ViewMetrics;
  /** Sum over the cases that reported a cost. */
  readonly costUsd: number;
  readonly costKnownForAllCases: boolean;
  /** Cases that reported a cost; 0 means the cost is unknown (e.g. an imported review without one). */
  readonly casesWithCost: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
}

export interface CaseMetricsInput {
  readonly caseId: string;
  readonly issues: readonly GoldenIssue[];
  readonly matched: readonly MatchedCandidate[];
  readonly costUsd: number | null;
  readonly tokens: number | null;
  readonly wallTimeMs: number | null;
}

function isTarget(issue: GoldenIssue): issue is GoldenIssue & { verdict: "real" | "partly" } {
  return issue.verdict === "real" || issue.verdict === "partly";
}

function issueWeight(issue: GoldenIssue & { verdict: "real" | "partly" }): number {
  return VERDICT_WEIGHTS[issue.verdict] * SEVERITY_WEIGHTS[issue.severity];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function emptyBySeverity(): Record<GoldenSeverity, FoundOfTotal> {
  const bySeverity = {} as Record<GoldenSeverity, FoundOfTotal>;
  for (const severity of GOLDEN_SEVERITIES) bySeverity[severity] = { found: 0, total: 0 };
  return bySeverity;
}

function viewMetrics(
  issues: readonly GoldenIssue[],
  matched: readonly MatchedCandidate[],
): ViewMetrics {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const foundIds = new Set<string>();
  let matchedTargets = 0;
  let knownFalse = 0;
  let unverifiable = 0;
  let unlabeled = 0;
  for (const candidate of matched) {
    const issue = candidate.issueId === null ? undefined : byId.get(candidate.issueId);
    if (issue === undefined) {
      unlabeled++;
    } else if (isTarget(issue)) {
      matchedTargets++;
      foundIds.add(issue.id);
    } else if (issue.verdict === "false") {
      knownFalse++;
    } else {
      unverifiable++;
    }
  }

  const targets = issues.filter(isTarget);
  const found = targets.filter((issue) => foundIds.has(issue.id));
  const weightedTotal = targets.reduce((sum, issue) => sum + issueWeight(issue), 0);
  const weightedFound = found.reduce((sum, issue) => sum + issueWeight(issue), 0);
  const realBySeverity = emptyBySeverity();
  for (const issue of targets) {
    if (issue.verdict !== "real") continue;
    const entry = realBySeverity[issue.severity];
    realBySeverity[issue.severity] = {
      found: entry.found + (foundIds.has(issue.id) ? 1 : 0),
      total: entry.total + 1,
    };
  }

  return {
    candidates: matched.length,
    targets: targets.length,
    targetsFound: found.length,
    recall: ratio(found.length, targets.length),
    weightedTotal,
    weightedFound,
    weightedRecall: ratio(weightedFound, weightedTotal),
    realBySeverity,
    matchedTargets,
    knownFalse,
    unverifiable,
    unlabeled,
    precisionLowerBound: ratio(matchedTargets, matched.length),
  };
}

export function computeCaseMetrics(input: CaseMetricsInput): CaseMetrics {
  return {
    caseId: input.caseId,
    shown: viewMetrics(
      input.issues,
      input.matched.filter((c) => c.bucket === "shown"),
    ),
    all: viewMetrics(input.issues, input.matched),
    costUsd: input.costUsd,
    tokens: input.tokens,
    wallTimeMs: input.wallTimeMs,
  };
}

function sumViews(views: readonly ViewMetrics[]): ViewMetrics {
  const sum = (pick: (v: ViewMetrics) => number) => views.reduce((acc, v) => acc + pick(v), 0);
  const realBySeverity = emptyBySeverity();
  for (const severity of GOLDEN_SEVERITIES) {
    realBySeverity[severity] = {
      found: sum((v) => v.realBySeverity[severity].found),
      total: sum((v) => v.realBySeverity[severity].total),
    };
  }
  const candidates = sum((v) => v.candidates);
  const targets = sum((v) => v.targets);
  const targetsFound = sum((v) => v.targetsFound);
  const weightedTotal = sum((v) => v.weightedTotal);
  const weightedFound = sum((v) => v.weightedFound);
  const matchedTargets = sum((v) => v.matchedTargets);
  return {
    candidates,
    targets,
    targetsFound,
    recall: ratio(targetsFound, targets),
    weightedTotal,
    weightedFound,
    weightedRecall: ratio(weightedFound, weightedTotal),
    realBySeverity,
    matchedTargets,
    knownFalse: sum((v) => v.knownFalse),
    unverifiable: sum((v) => v.unverifiable),
    unlabeled: sum((v) => v.unlabeled),
    precisionLowerBound: ratio(matchedTargets, candidates),
  };
}

export function aggregateMetrics(cases: readonly CaseMetrics[]): TotalMetrics {
  return {
    cases: cases.length,
    shown: sumViews(cases.map((c) => c.shown)),
    all: sumViews(cases.map((c) => c.all)),
    costUsd: cases.reduce((acc, c) => acc + (c.costUsd ?? 0), 0),
    costKnownForAllCases: cases.every((c) => c.costUsd !== null),
    casesWithCost: cases.filter((c) => c.costUsd !== null).length,
    tokens: cases.reduce((acc, c) => acc + (c.tokens ?? 0), 0),
    wallTimeMs: cases.reduce((acc, c) => acc + (c.wallTimeMs ?? 0), 0),
  };
}
