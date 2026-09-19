/**
 * Runs the phase 0b surface-profile spike (H0', SPEC §4.2, §5 Fase 0b) over
 * a set of hunks against any DecisionPort. Mirrors
 * `spike/spike-runner.ts`'s shape (one Jev request per batch, continue
 * past a failed batch recording one failure per hunk), but extracts the
 * profile question set's answers: one choice (`change_kind`) and four
 * nouls, instead of the defect set's one score and two nouls.
 */
import type { ChoiceDecision, Decision, NoulDecision, Usage } from "../../domain/decision.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { profileQuestionSet } from "../spike/question-sets/profile.js";
import { buildFanOut, fanOutKey } from "../spike/questions.js";
import { getSerializer } from "../spike/serializers.js";

export interface ProfileHunkResult {
  readonly hunkId: string;
  readonly serializer: string;
  readonly changeKind: string;
  readonly changeKindProbabilities: Record<string, number>;
  readonly changeKindConfidence: number;
  readonly touchesPublicApi: number;
  readonly touchesErrorHandling: number;
  readonly touchesAsync: number;
  readonly touchesIo: number;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export interface ProfileHunkFailure {
  readonly hunkId: string;
  readonly batchIndex: number;
  readonly error: string;
}

export interface ProfileRunTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalLatencyMs: number;
  readonly wallTimeMs: number;
}

export interface ProfileRunResult {
  readonly results: ProfileHunkResult[];
  readonly failures: ProfileHunkFailure[];
  readonly totals: ProfileRunTotals;
}

export interface RunProfileSpikeOptions {
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

function asChoiceDecision(decision: Decision, key: string): ChoiceDecision {
  if (decision.type !== "choice") {
    throw new Error(`expected a choice decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

function asNoulDecision(decision: Decision, key: string): NoulDecision {
  if (decision.type !== "noul") {
    throw new Error(`expected a noul decision for "${key}", got "${decision.type}"`);
  }
  return decision;
}

export async function runProfileSpike(options: RunProfileSpikeOptions): Promise<ProfileRunResult> {
  const serializer = getSerializer(options.serializerName);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = buildFanOut(options.hunks, serializer, batchSize, profileQuestionSet);
  const now = options.now ?? Date.now;
  const wallStart = now();

  const results: ProfileHunkResult[] = [];
  const failures: ProfileHunkFailure[] = [];
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
        const changeKindKey = fanOutKey(hunkId, "change_kind");
        const apiKey = fanOutKey(hunkId, "touches_public_api");
        const errKey = fanOutKey(hunkId, "touches_error_handling");
        const asyncKey = fanOutKey(hunkId, "touches_async");
        const ioKey = fanOutKey(hunkId, "touches_io");

        const changeKind = asChoiceDecision(
          requireAnswer(response.answers, changeKindKey),
          changeKindKey,
        );
        const api = asNoulDecision(requireAnswer(response.answers, apiKey), apiKey);
        const err = asNoulDecision(requireAnswer(response.answers, errKey), errKey);
        const asyncDecision = asNoulDecision(requireAnswer(response.answers, asyncKey), asyncKey);
        const io = asNoulDecision(requireAnswer(response.answers, ioKey), ioKey);

        results.push({
          hunkId,
          serializer: serializer.name,
          changeKind: changeKind.choice,
          changeKindProbabilities: changeKind.probabilities,
          changeKindConfidence: changeKind.confidence,
          touchesPublicApi: api.noul,
          touchesErrorHandling: err.noul,
          touchesAsync: asyncDecision.noul,
          touchesIo: io.noul,
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
