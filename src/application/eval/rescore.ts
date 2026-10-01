/**
 * Re-scores a stored eval run (docs/EVAL.md "Re-scoring a run"): the
 * candidates a run already produced — every case's `candidates` in its
 * results.json, with claim, failing scenario and evidence when the source
 * had them — are matched again against a (possibly updated) golden set, and
 * scored, WITHOUT re-running the pipeline or re-reading an import. Each
 * case keeps its cost, tokens, wall time and error from the run.
 *
 * Only cases both the run and the set have are scored; the others are
 * logged. A matcher in front of the on-disk cache makes unchanged decisions
 * free, so re-scoring after adding a few issues costs a few calls.
 */
import type { FindingMatcherPort } from "../../domain/ports/finding-matcher-port.js";
import type { CandidateFinding } from "./candidate.js";
import { type CaseRun, type EvalCaseResult, type EvalResults, runEval } from "./eval-run.js";
import type { GoldenCase } from "./golden-set.js";
import type { MatchedCandidate } from "./match-candidates.js";

export class RescoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RescoreError";
  }
}

export interface RescoreRunInput {
  /** The stored run (its results.json). */
  readonly previous: EvalResults;
  /** Where the run was read from; recorded in `source.run`. */
  readonly runPath: string;
  /** The variant name of the re-scored results (the run's, or `--as`). */
  readonly variant: string;
  readonly setPath: string;
  readonly cases: readonly GoldenCase[];
  readonly matcher: FindingMatcherPort;
  readonly matcherInfo: Readonly<Record<string, unknown>>;
  /** Matcher calls in flight per case. Default 1. */
  readonly matcherConcurrency?: number;
  /** Cases matched at once. Default 1. */
  readonly concurrency?: number;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

function storedCandidate(matched: MatchedCandidate): CandidateFinding {
  const { issueId: _drop, ...candidate } = matched;
  return candidate;
}

function storedRun(stored: EvalCaseResult): CaseRun {
  return {
    caseId: stored.caseId,
    candidates: stored.candidates.map(storedCandidate),
    costUsd: stored.metrics.costUsd,
    tokens: stored.metrics.tokens,
    wallTimeMs: stored.metrics.wallTimeMs,
    error: stored.error,
  };
}

/** The source that first produced the candidates, kept across re-scores of re-scores. */
function originalSource(previous: EvalResults): Readonly<Record<string, unknown>> {
  const source = previous.source;
  if (source.type === "rescore" && typeof source.original === "object" && source.original) {
    return source.original as Readonly<Record<string, unknown>>;
  }
  return source;
}

export async function rescoreRun(input: RescoreRunInput): Promise<EvalResults> {
  const log = input.log ?? (() => {});
  const stored = new Map(input.previous.cases.map((c) => [c.caseId, c]));
  const setIds = new Set(input.cases.map((c) => c.id));

  for (const goldenCase of input.cases) {
    if (!stored.has(goldenCase.id)) log(`[rescore] ${goldenCase.id}: not in the run, skipped`);
  }
  for (const caseId of stored.keys()) {
    if (!setIds.has(caseId)) log(`[rescore] ${caseId}: not in the set, dropped`);
  }
  const cases = input.cases.filter((c) => stored.has(c.id));
  if (cases.length === 0) {
    throw new RescoreError(
      `the set shares no case with the run at ${input.runPath} (run cases: ${[...stored.keys()].join(", ") || "none"})`,
    );
  }

  const results = await runEval({
    variant: input.variant,
    setPath: input.setPath,
    cases,
    source: async (goldenCase) => storedRun(stored.get(goldenCase.id) as EvalCaseResult),
    sourceInfo: {
      type: "rescore",
      run: input.runPath,
      runVariant: input.previous.variant,
      runCreatedAt: input.previous.createdAt,
      original: originalSource(input.previous),
    },
    matcher: input.matcher,
    matcherInfo: input.matcherInfo,
    ...(input.matcherConcurrency !== undefined
      ? { matcherConcurrency: input.matcherConcurrency }
      : {}),
    // Sequential case order for runEval's own wall-time bookkeeping; the
    // run's real wall time is restored below.
    concurrency: input.concurrency ?? 1,
    ...(input.now !== undefined ? { now: input.now } : {}),
    log,
  });

  // The wall time is the run's, not the re-score's: the run's total when
  // every case was kept (it may be the elapsed time of a parallel run),
  // the sum of the kept cases otherwise.
  const keptAll = cases.length === stored.size;
  const wallTimeMs = keptAll
    ? input.previous.totals.wallTimeMs
    : results.cases.reduce((sum, c) => sum + (c.metrics.wallTimeMs ?? 0), 0);
  return { ...results, totals: { ...results.totals, wallTimeMs } };
}
