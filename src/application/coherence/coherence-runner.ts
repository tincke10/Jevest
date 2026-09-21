/**
 * Runs the phase 0c intent–change coherence spike (H7, SPEC §4.2, §5 Fase
 * 0c) over the crossed-description pairs against any DecisionPort. Mirrors
 * profile/profile-runner.ts (continue past a failed item, record one
 * failure per item, ProfileRunTotals-shaped totals) but the unit is a PAIR,
 * not a hunk, and there is exactly one Jev request per pair — NFR-14 batch
 * anchoring rules out packing several pairs into one request.
 *
 * Per pair the state is assembled as: intent = title/body/labels of the
 * DESCRIPTION PR, change facts = describeChange over the files of the
 * CHANGE PR, change summary = the CHANGE PR's summary in the "with-summary"
 * variant, absent in "without-summary". A missing summary in the
 * with-summary variant is a hard error before any request is made: running
 * a with-summary arm with holes would silently measure a mix of both arms.
 *
 * Nouls carry no native confidence (SPEC §1.1, domain/decision.ts), so the
 * per-noul `confidence` reported here is DERIVED: |2p − 1|, the distance of
 * the probability from indifference, on the same 0..1 scale as a choice's
 * confidence. The report says so wherever it prints it.
 */
import type { ChoiceDecision, Decision, NoulDecision, Usage } from "../../domain/decision.js";
import type { ChangeSummary } from "../../domain/ports/change-summarizer-port.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { Question } from "../../domain/question.js";
import { describeChange } from "./change-facts.js";
import { buildCoherenceState } from "./coherence-state.js";
import type { CoherenceLabel, CoherencePair, PrRecord } from "./pr-record.js";
import { coherenceQuestionSet } from "./question-set.js";

export const COHERENCE_VARIANTS = ["with-summary", "without-summary"] as const;
export type CoherenceVariant = (typeof COHERENCE_VARIANTS)[number];

export interface NoulAnswer {
  readonly probability: number;
  /** Derived: |2p − 1|. Nouls have no native confidence. */
  readonly confidence: number;
}

export interface ChoiceAnswer {
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

export interface CoherencePairResult {
  /** `${prId}|${descriptionPrId}`, see {@link pairIdOf}. */
  readonly pairId: string;
  readonly prId: string;
  readonly descriptionPrId: string;
  readonly label: CoherenceLabel;
  readonly variant: CoherenceVariant;
  readonly matchesIntent: NoulAnswer;
  readonly userFacing: NoulAnswer;
  readonly breaking: NoulAnswer;
  readonly needsProductOwner: NoulAnswer;
  readonly riskLevel: ChoiceAnswer;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export interface CoherencePairFailure {
  readonly pairId: string;
  readonly pairIndex: number;
  readonly error: string;
}

export interface CoherenceRunTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalLatencyMs: number;
  readonly wallTimeMs: number;
}

export interface CoherenceRunResult {
  readonly variant: CoherenceVariant;
  readonly results: CoherencePairResult[];
  readonly failures: CoherencePairFailure[];
  readonly totals: CoherenceRunTotals;
}

export interface RunCoherenceSpikeOptions {
  readonly port: DecisionPort;
  readonly records: readonly PrRecord[];
  readonly pairs: readonly CoherencePair[];
  /** Keyed by PR id (the CHANGE side). Ignored in the without-summary variant. */
  readonly summaries: ReadonlyMap<string, ChangeSummary> | null;
  readonly variant: CoherenceVariant;
  readonly onProgress?: (info: { completedPairs: number; totalPairs: number }) => void;
  readonly now?: () => number;
}

export class MissingSummaryError extends Error {
  constructor(prIds: readonly string[]) {
    super(
      `variant "with-summary" has no change summary for ${prIds.length} pull request(s): ${prIds.join(", ")}. Run the summary pass first (pnpm coherence:summarize).`,
    );
    this.name = "MissingSummaryError";
  }
}

export function pairIdOf(pair: CoherencePair): string {
  return `${pair.prId}|${pair.descriptionPrId}`;
}

/** |2p − 1|: how far a probability sits from indifference, on a 0..1 scale. */
export function noulConfidence(probability: number): number {
  return Math.abs(2 * probability - 1);
}

function buildQuestions(): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const question of coherenceQuestionSet.questions) {
    questions[question.name] = question.build();
  }
  return questions;
}

function requireAnswer(answers: Record<string, Decision>, key: string): Decision {
  const decision = answers[key];
  if (!decision) {
    throw new Error(`missing decision for question "${key}"`);
  }
  return decision;
}

function asNoul(answers: Record<string, Decision>, key: string): NoulAnswer {
  const decision = requireAnswer(answers, key);
  if (decision.type !== "noul") {
    throw new Error(`expected a noul decision for "${key}", got "${decision.type}"`);
  }
  const { noul } = decision as NoulDecision;
  return { probability: noul, confidence: noulConfidence(noul) };
}

function asChoice(answers: Record<string, Decision>, key: string): ChoiceAnswer {
  const decision = requireAnswer(answers, key);
  if (decision.type !== "choice") {
    throw new Error(`expected a choice decision for "${key}", got "${decision.type}"`);
  }
  const { choice, probabilities, confidence } = decision as ChoiceDecision;
  return { choice, probabilities: { ...probabilities }, confidence };
}

function requireRecord(byId: ReadonlyMap<string, PrRecord>, id: string): PrRecord {
  const record = byId.get(id);
  if (!record) {
    throw new Error(`pull request "${id}" is not in the dataset`);
  }
  return record;
}

function assertSummariesPresent(
  pairs: readonly CoherencePair[],
  summaries: ReadonlyMap<string, ChangeSummary> | null,
): ReadonlyMap<string, ChangeSummary> {
  const missing = [...new Set(pairs.map((p) => p.prId))].filter(
    (prId) => summaries === null || !summaries.has(prId),
  );
  if (missing.length > 0) {
    throw new MissingSummaryError(missing);
  }
  return summaries as ReadonlyMap<string, ChangeSummary>;
}

export async function runCoherenceSpike(
  options: RunCoherenceSpikeOptions,
): Promise<CoherenceRunResult> {
  const now = options.now ?? Date.now;
  const wallStart = now();
  const byId = new Map(options.records.map((r) => [r.id, r]));
  const summaries =
    options.variant === "with-summary"
      ? assertSummariesPresent(options.pairs, options.summaries)
      : null;

  const results: CoherencePairResult[] = [];
  const failures: CoherencePairFailure[] = [];
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalLatencyMs = 0;

  for (const [i, pair] of options.pairs.entries()) {
    const pairId = pairIdOf(pair);
    try {
      const changePr = requireRecord(byId, pair.prId);
      const descriptionPr = requireRecord(byId, pair.descriptionPrId);
      const state = buildCoherenceState({
        intent: {
          title: descriptionPr.title,
          body: descriptionPr.body,
          labels: descriptionPr.labels,
        },
        change: describeChange(changePr.files),
        summary: summaries?.get(pair.prId) ?? null,
      });

      const response = await options.port.decide(state, buildQuestions());
      requests += 1;
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      totalLatencyMs += response.latencyMs;

      const answers: Record<string, Decision> = response.answers;
      results.push({
        pairId,
        prId: pair.prId,
        descriptionPrId: pair.descriptionPrId,
        label: pair.label,
        variant: options.variant,
        matchesIntent: asNoul(answers, "matches_intent"),
        userFacing: asNoul(answers, "user_facing"),
        breaking: asNoul(answers, "breaking"),
        needsProductOwner: asNoul(answers, "needs_product_owner"),
        riskLevel: asChoice(answers, "risk_level"),
        requestId: response.requestId,
        latencyMs: response.latencyMs,
        usage: response.usage,
      });
    } catch (error) {
      failures.push({
        pairId,
        pairIndex: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    options.onProgress?.({ completedPairs: i + 1, totalPairs: options.pairs.length });
  }

  return {
    variant: options.variant,
    results,
    failures,
    totals: { requests, inputTokens, outputTokens, totalLatencyMs, wallTimeMs: now() - wallStart },
  };
}
