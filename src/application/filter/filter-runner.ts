/**
 * Runs the finding-filter (H1, SPEC §5 Fase 1a step 3) over a set of
 * findings against any DecisionPort. Mirrors `spike/spike-runner.ts` and
 * `profile/profile-runner.ts`'s shape (one Jev request per batch, continue
 * past a failed batch recording one failure per finding), extracting one
 * noul (`is_real_defect`), one score (`severity`), and two more nouls
 * (`is_style_only`, `actionable`) per finding.
 */
import type { Decision, NoulDecision, ScoreDecision, Usage } from "../../domain/decision.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import { fanOutKey } from "../spike/questions.js";
import { buildFindingFanOut } from "./finding-questions.js";
import type { FindingRecord } from "./finding-record.js";

export interface FindingResult {
  readonly findingId: string;
  readonly isRealDefectProb: number;
  /** Continuous expected score over the 4-level nit/minor/major/critical rubric (0..3). */
  readonly severity: number;
  readonly severityConfidence: number;
  readonly severityProbabilities: Record<number, number>;
  readonly isStyleOnlyProb: number;
  readonly actionableProb: number;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export interface FindingFailure {
  readonly findingId: string;
  readonly batchIndex: number;
  readonly error: string;
}

export interface FilterRunTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalLatencyMs: number;
  readonly wallTimeMs: number;
}

export interface FilterRunResult {
  readonly results: FindingResult[];
  readonly failures: FindingFailure[];
  readonly totals: FilterRunTotals;
}

export interface RunFilterOptions {
  readonly port: DecisionPort;
  readonly findings: readonly FindingRecord[];
  readonly hunkDiffsById: ReadonlyMap<string, string>;
  /**
   * Findings per Jev request. Default 1 — batch anchoring (SPEC NFR-14,
   * docs/analysis/h0-prime-error-analysis.md) makes answers converge
   * within a batch, so >1 is for cost experiments only, not evidence.
   */
  readonly batchSize?: number;
  readonly onProgress?: (info: { completedBatches: number; totalBatches: number }) => void;
  readonly now?: () => number;
}

const DEFAULT_BATCH_SIZE = 1;

function requireAnswer(answers: Record<string, Decision>, key: string): Decision {
  const decision = answers[key];
  if (!decision) {
    throw new Error(`missing decision for fan-out key "${key}"`);
  }
  return decision;
}

function asNoulDecision(decision: Decision, key: string): NoulDecision {
  if (decision.type !== "noul") {
    throw new Error(`expected a noul decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

function asScoreDecision(decision: Decision, key: string): ScoreDecision {
  if (decision.type !== "score") {
    throw new Error(`expected a score decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

export async function runFilter(options: RunFilterOptions): Promise<FilterRunResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = buildFindingFanOut(options.findings, options.hunkDiffsById, batchSize);
  const now = options.now ?? Date.now;
  const wallStart = now();

  const results: FindingResult[] = [];
  const failures: FindingFailure[] = [];
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

      for (const findingId of batch.findingIds) {
        const realKey = fanOutKey(findingId, "is_real_defect");
        const severityKey = fanOutKey(findingId, "severity");
        const styleKey = fanOutKey(findingId, "is_style_only");
        const actionableKey = fanOutKey(findingId, "actionable");

        const isReal = asNoulDecision(requireAnswer(response.answers, realKey), realKey);
        const severity = asScoreDecision(requireAnswer(response.answers, severityKey), severityKey);
        const styleOnly = asNoulDecision(requireAnswer(response.answers, styleKey), styleKey);
        const actionable = asNoulDecision(
          requireAnswer(response.answers, actionableKey),
          actionableKey,
        );

        results.push({
          findingId,
          isRealDefectProb: isReal.noul,
          severity: severity.score,
          severityConfidence: severity.confidence,
          severityProbabilities: severity.probabilities,
          isStyleOnlyProb: styleOnly.noul,
          actionableProb: actionable.noul,
          requestId: response.requestId,
          latencyMs: response.latencyMs,
          usage: response.usage,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const findingId of batch.findingIds) {
        failures.push({ findingId, batchIndex: i, error: message });
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
