/**
 * Runs the phase 0 spike over a set of hunks against any DecisionPort
 * (fake, recorded, or real). One Jev request per batch (FR-1.4); a failed
 * batch is recorded as a per-hunk failure and the run continues (SPEC §10.2
 * stage tests, NFR-2 "fail closed" in spirit — the spike keeps going and
 * reports what it could not classify instead of aborting the whole run).
 */
import type { Decision, NoulDecision, ScoreDecision, Usage } from "../../domain/decision.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { HunkRecord } from "./hunk-record.js";
import { defectQuestionSet } from "./question-sets/defect.js";
import { buildFanOut, fanOutKey } from "./questions.js";
import { getSerializer } from "./serializers.js";

export interface HunkResult {
  readonly hunkId: string;
  readonly serializer: string;
  /** Continuous expected score over the 4-level defect_likelihood rubric (0..3). */
  readonly defectScore: number;
  readonly defectProbabilities: Record<number, number>;
  readonly defectConfidence: number;
  /** Probability that the hunk touches a public API. */
  readonly touchesPublicApi: number;
  /** Probability that the hunk touches a security-relevant concern. */
  readonly touchesSecurity: number;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export interface HunkFailure {
  readonly hunkId: string;
  readonly batchIndex: number;
  readonly error: string;
}

export interface SpikeRunTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalLatencyMs: number;
  readonly wallTimeMs: number;
}

export interface SpikeRunResult {
  readonly results: HunkResult[];
  readonly failures: HunkFailure[];
  readonly totals: SpikeRunTotals;
}

export interface RunSpikeOptions {
  readonly port: DecisionPort;
  readonly hunks: readonly HunkRecord[];
  readonly serializerName: string;
  /**
   * Hunks per Jev request. Default 1 — batch anchoring (SPEC NFR-14,
   * docs/analysis/h0-prime-error-analysis.md) makes answers converge
   * within a batch, so >1 is for cost experiments only, not evidence.
   */
  readonly batchSize?: number;
  readonly onProgress?: (info: { completedBatches: number; totalBatches: number }) => void;
  /** Injectable clock for deterministic wall-time tests. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_BATCH_SIZE = 1;

function asScoreDecision(decision: Decision, key: string): ScoreDecision {
  if (decision.type !== "score") {
    throw new Error(`expected a score decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

function asNoulDecision(decision: Decision, key: string): NoulDecision {
  if (decision.type !== "noul") {
    throw new Error(`expected a noul decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

function requireAnswer(answers: Record<string, Decision>, key: string): Decision {
  const decision = answers[key];
  if (!decision) {
    throw new Error(`missing decision for fan-out key "${key}"`);
  }
  return decision;
}

export async function runSpike(options: RunSpikeOptions): Promise<SpikeRunResult> {
  const serializer = getSerializer(options.serializerName);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = buildFanOut(options.hunks, serializer, batchSize, defectQuestionSet);
  const now = options.now ?? Date.now;
  const wallStart = now();

  const results: HunkResult[] = [];
  const failures: HunkFailure[] = [];
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalLatencyMs = 0;

  for (const [i, batch] of batches.entries()) {
    try {
      const response = await options.port.decide(batch.state, batch.questions);
      requests += 1;
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      totalLatencyMs += response.latencyMs;

      for (const hunkId of batch.hunkIds) {
        const defectKey = fanOutKey(hunkId, "defect_likelihood");
        const apiKey = fanOutKey(hunkId, "touches_public_api");
        const secKey = fanOutKey(hunkId, "touches_security");

        const defect = asScoreDecision(requireAnswer(response.answers, defectKey), defectKey);
        const publicApi = asNoulDecision(requireAnswer(response.answers, apiKey), apiKey);
        const security = asNoulDecision(requireAnswer(response.answers, secKey), secKey);

        results.push({
          hunkId,
          serializer: serializer.name,
          defectScore: defect.score,
          defectProbabilities: defect.probabilities,
          defectConfidence: defect.confidence,
          touchesPublicApi: publicApi.noul,
          touchesSecurity: security.noul,
          requestId: response.requestId,
          latencyMs: response.latencyMs,
          usage: response.usage,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const hunkId of batch.hunkIds) {
        failures.push({ hunkId, batchIndex: i, error: message });
      }
    }

    options.onProgress?.({ completedBatches: i + 1, totalBatches: batches.length });
  }

  const wallTimeMs = now() - wallStart;

  return {
    results,
    failures,
    totals: { requests, inputTokens, outputTokens, totalLatencyMs, wallTimeMs },
  };
}
