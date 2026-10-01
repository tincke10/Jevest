/**
 * One eval run (docs/EVAL.md): every golden case goes through a
 * {@link CaseSource} (the pipeline, or an imported review), its candidates
 * are matched to the case's golden issues, and the result is scored. A
 * case whose source throws is recorded with its error and no candidates —
 * its issues still count as missed — so one broken case never hides the
 * others.
 */
import type { FindingMatcherPort } from "../../domain/ports/finding-matcher-port.js";
import type { CandidateFinding } from "./candidate.js";
import type { GoldenCase } from "./golden-set.js";
import { mapLimit } from "./map-limit.js";
import { type MatchedCandidate, matchCandidates } from "./match-candidates.js";
import {
  type CaseMetrics,
  SEVERITY_WEIGHTS,
  type TotalMetrics,
  VERDICT_WEIGHTS,
  aggregateMetrics,
  computeCaseMetrics,
} from "./metrics.js";

export const EVAL_RESULTS_SCHEMA_VERSION = 1;

export interface CaseRun {
  readonly caseId: string;
  readonly candidates: readonly CandidateFinding[];
  readonly costUsd: number | null;
  readonly tokens: number | null;
  readonly wallTimeMs: number | null;
  readonly error: string | null;
}

export type CaseSource = (goldenCase: GoldenCase) => Promise<CaseRun>;

export interface EvalCaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly error: string | null;
  /** The case's known-false issue ids, so reports can list known noise without the set. */
  readonly falseIssueIds: readonly string[];
  readonly candidates: readonly MatchedCandidate[];
  readonly metrics: CaseMetrics;
}

export interface EvalResults {
  readonly schema: typeof EVAL_RESULTS_SCHEMA_VERSION;
  readonly variant: string;
  readonly createdAt: string;
  readonly setPath: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly matcher: Readonly<Record<string, unknown>> & {
    readonly calls: number;
    readonly cacheHits: number;
    readonly costUsd: number;
  };
  readonly weights: {
    readonly verdict: typeof VERDICT_WEIGHTS;
    readonly severity: typeof SEVERITY_WEIGHTS;
  };
  readonly cases: readonly EvalCaseResult[];
  readonly totals: TotalMetrics;
}

export interface RunEvalInput {
  readonly variant: string;
  readonly setPath: string;
  readonly cases: readonly GoldenCase[];
  readonly source: CaseSource;
  readonly sourceInfo: Readonly<Record<string, unknown>>;
  readonly matcher: FindingMatcherPort;
  readonly matcherInfo: Readonly<Record<string, unknown>>;
  /** Matcher calls in flight per case. Default 1. */
  readonly matcherConcurrency?: number;
  /**
   * Cases in flight at once (a bounded pool). Default 1 = sequential, the
   * original behavior. Results keep the set's case order whatever the
   * completion order. With more than 1, `totals.wallTimeMs` is the real
   * elapsed time of the run (the per-case wall times stay as measured).
   */
  readonly concurrency?: number;
  /** Monotonic millisecond clock, injectable for tests. */
  readonly clock?: () => number;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export async function runEval(input: RunEvalInput): Promise<EvalResults> {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => {});
  const createdAt = now().toISOString();
  const concurrency = input.concurrency ?? 1;
  const clock = input.clock ?? (() => performance.now());
  const startedAt = clock();

  const outcomes = await mapLimit(input.cases, concurrency, async (goldenCase) => {
    let run: CaseRun;
    try {
      run = await input.source(goldenCase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[eval] ${goldenCase.id}: source failed: ${message}`);
      run = {
        caseId: goldenCase.id,
        candidates: [],
        costUsd: null,
        tokens: null,
        wallTimeMs: null,
        error: message,
      };
    }
    const matching = await matchCandidates({
      issues: goldenCase.issues,
      candidates: run.candidates,
      matcher: input.matcher,
      ...(input.matcherConcurrency !== undefined ? { concurrency: input.matcherConcurrency } : {}),
    });
    const metrics = computeCaseMetrics({
      caseId: goldenCase.id,
      issues: goldenCase.issues,
      matched: matching.matched,
      costUsd: run.costUsd,
      tokens: run.tokens,
      wallTimeMs: run.wallTimeMs,
    });
    log(
      `[eval] ${goldenCase.id}: ${run.candidates.length} candidate(s), ${metrics.shown.targetsFound}/${metrics.shown.targets} target(s) found shown, ${metrics.shown.unlabeled} unlabeled shown`,
    );
    const result: EvalCaseResult = {
      caseId: goldenCase.id,
      title: goldenCase.title,
      error: run.error,
      falseIssueIds: goldenCase.issues.filter((i) => i.verdict === "false").map((i) => i.id),
      candidates: matching.matched,
      metrics,
    };
    return { result, matching };
  });

  // Folded in case order (not completion order) so sums are deterministic.
  const cases: EvalCaseResult[] = [];
  let calls = 0;
  let cacheHits = 0;
  let matcherCostUsd = 0;
  for (const { result, matching } of outcomes) {
    cases.push(result);
    calls += matching.matcherCalls;
    cacheHits += matching.cacheHits;
    matcherCostUsd += matching.matcherCostUsd;
  }
  const totals = aggregateMetrics(cases.map((c) => c.metrics));
  const elapsedMs = Math.round(clock() - startedAt);

  return {
    schema: EVAL_RESULTS_SCHEMA_VERSION,
    variant: input.variant,
    createdAt,
    setPath: input.setPath,
    source: input.sourceInfo,
    matcher: { ...input.matcherInfo, calls, cacheHits, costUsd: matcherCostUsd },
    weights: { verdict: VERDICT_WEIGHTS, severity: SEVERITY_WEIGHTS },
    cases,
    totals: concurrency > 1 ? { ...totals, wallTimeMs: elapsedMs } : totals,
  };
}
