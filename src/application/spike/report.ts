/**
 * Turns raw per-hunk spike results into the H0 evaluation report (SPEC §4,
 * §8 FR-8.2/FR-8.4): threshold sweep, best-F1 point, confusion matrix, ECE
 * for both nouls, latency percentiles, token/cost totals, per-hunk detail,
 * cross-serializer agreement, and the H0 verdict — plus a Markdown render.
 */
import {
  type H0Criteria,
  type H0VerdictResult,
  type ThresholdMetrics,
  expectedCalibrationError,
  h0Verdict,
  thresholdSweep,
} from "../../domain/metrics.js";
import type { HunkRecordLabel } from "./hunk-record.js";
import { DEFECT_LIKELIHOOD_LEVELS } from "./questions.js";
import type { HunkFailure, HunkResult } from "./spike-runner.js";

/** Sweep points at 5% steps from 0.05 to 0.95, inclusive. */
const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);

/** SPEC §4 H0 criteria: recall >= 0.85 and F1 >= 0.75. */
const DEFAULT_H0_CRITERIA: H0Criteria = { minRecall: 0.85, minF1: 0.75 };

/** SPEC §1: Jev pricing is $0.042/MTok input; output is free. */
const DEFAULT_COST_PER_MTOK_INPUT_USD = 0.042;

/** Dataset schema version when a hunk record doesn't carry `dataset_version`. */
const DEFAULT_DATASET_VERSION = 1;

/** How many hunk ids to list under each Markdown "consistent errors" section. */
const CONSISTENT_ERRORS_DISPLAY_LIMIT = 20;

export interface SerializerHunkResult {
  readonly hunkId: string;
  readonly actualDefect: boolean;
  readonly defectScoreRaw: number | null;
  readonly defectScoreNormalized: number | null;
  readonly defectConfidence: number | null;
  readonly defectProbabilities: Record<number, number> | null;
  readonly touchesPublicApi: number | null;
  readonly touchesPublicApiLabel: boolean | null;
  readonly touchesSecurity: number | null;
  readonly touchesSecurityLabel: boolean | null;
  readonly requestId: string | null;
  readonly error: string | null;
}

export interface ConfidenceSummary {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly mean: number;
}

export interface SerializerReport {
  readonly serializer: string;
  readonly sampleCount: number;
  readonly sweep: ThresholdMetrics[];
  readonly bestThreshold: number;
  readonly bestMetrics: ThresholdMetrics;
  readonly ece: {
    readonly touchesPublicApi: number | null;
    readonly touchesSecurity: number | null;
  };
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly tokens: { readonly input: number; readonly output: number };
  readonly estimatedCostUsd: number;
  readonly h0: H0VerdictResult;
  /** null when the serializer has zero successful hunks. */
  readonly confidence: ConfidenceSummary | null;
  readonly hunks: SerializerHunkResult[];
}

export interface HunkAgreementEntry {
  readonly hunkId: string;
  /** Predicted defect (true/false) per serializer, at that serializer's own best threshold. */
  readonly predictions: Record<string, boolean>;
  readonly agree: boolean;
  /** The shared predicted value when all serializers agree; null when they disagree. */
  readonly agreedPrediction: boolean | null;
}

export interface AgreementSummary {
  /** Only hunks with a successful result in every reported serializer. */
  readonly hunks: HunkAgreementEntry[];
  readonly agreedCount: number;
  readonly totalCount: number;
}

export interface SpikeReport {
  readonly generatedAt: string;
  readonly datasetVersion: number;
  readonly serializers: SerializerReport[];
  readonly agreement: AgreementSummary;
  readonly overallVerdict: "PASS" | "FAIL";
}

export interface SerializerRunResult {
  readonly results: readonly HunkResult[];
  readonly failures: readonly HunkFailure[];
}

export interface BuildSpikeReportOptions {
  /** Normalized (0..1) thresholds to sweep. Default: 0.05 steps from 0.05 to 0.95. */
  readonly thresholds?: readonly number[];
  readonly h0Criteria?: H0Criteria;
  readonly costPerMTokInputUsd?: number;
  /** Injectable clock for deterministic tests. Default: `() => new Date()`. */
  readonly now?: () => Date;
  /** Traceability: which dataset version this run used. Default: 1. */
  readonly datasetVersion?: number;
}

/**
 * The 4-level `defect_likelihood` rubric yields a continuous "expected
 * score" in [0, levels-1] (SDK: a probability-weighted average over the
 * rubric, not necessarily an integer). We normalize it to [0, 1] by
 * dividing by the top rubric index (3, for 4 levels: none/unlikely/
 * likely/certain), so the same threshold sweep works across rubrics of
 * any length.
 */
function normalizeScore(score: number): number {
  const maxIndex = DEFECT_LIKELIHOOD_LEVELS.length - 1;
  return score / maxIndex;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(idx);
  const upperIndex = Math.ceil(idx);
  const lower = sorted.at(lowerIndex);
  const upper = sorted.at(upperIndex);
  if (lower === undefined || upper === undefined) {
    // Unreachable: lowerIndex/upperIndex are always within [0, sorted.length - 1].
    throw new Error("percentile: index out of range");
  }
  if (lowerIndex === upperIndex) {
    return lower;
  }
  const weight = idx - lowerIndex;
  return lower * (1 - weight) + upper * weight;
}

interface LabeledResult {
  readonly result: HunkResult;
  readonly label: HunkRecordLabel;
}

function buildSerializerReport(
  serializer: string,
  run: SerializerRunResult,
  labelsByHunkId: Record<string, HunkRecordLabel>,
  thresholds: readonly number[],
  h0Criteria: H0Criteria,
  costPerMTokInputUsd: number,
): SerializerReport {
  const items: LabeledResult[] = [];
  for (const result of run.results) {
    const label = labelsByHunkId[result.hunkId];
    if (label) {
      items.push({ result, label });
    }
  }

  const scoreItems = items.map(({ result, label }) => ({
    score: normalizeScore(result.defectScore),
    actual: label.defect,
  }));
  const sweep = thresholdSweep(scoreItems, thresholds);

  let best: ThresholdMetrics = sweep[0] ?? {
    threshold: 0.5,
    matrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
    precision: 0,
    recall: 0,
    f1: 0,
  };
  for (const candidate of sweep) {
    if (candidate.f1 > best.f1) {
      best = candidate;
    }
  }

  const apiItems = items
    .filter(({ label }) => label.touchesPublicApi !== null)
    .map(({ result, label }) => ({
      prob: result.touchesPublicApi,
      actual: label.touchesPublicApi as boolean,
    }));
  const secItems = items
    .filter(({ label }) => label.touchesSecurity !== null)
    .map(({ result, label }) => ({
      prob: result.touchesSecurity,
      actual: label.touchesSecurity as boolean,
    }));

  const ece = {
    touchesPublicApi: apiItems.length > 0 ? expectedCalibrationError(apiItems) : null,
    touchesSecurity: secItems.length > 0 ? expectedCalibrationError(secItems) : null,
  };

  // Hunks in the same fan-out batch share one Jev request: dedupe by
  // requestId before summing tokens or measuring latency, or a large batch
  // would inflate both by its own size.
  const byRequest = new Map<
    string,
    { latencyMs: number; inputTokens: number; outputTokens: number }
  >();
  for (const { result } of items) {
    if (!byRequest.has(result.requestId)) {
      byRequest.set(result.requestId, {
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    }
  }
  const uniqueRequests = [...byRequest.values()];
  const latencies = uniqueRequests.map((r) => r.latencyMs);
  const inputTokens = uniqueRequests.reduce((sum, r) => sum + r.inputTokens, 0);
  const outputTokens = uniqueRequests.reduce((sum, r) => sum + r.outputTokens, 0);

  const confidences = items.map(({ result }) => result.defectConfidence);
  const confidence: ConfidenceSummary | null =
    confidences.length > 0
      ? {
          p10: percentile(confidences, 10),
          p50: percentile(confidences, 50),
          p90: percentile(confidences, 90),
          mean: confidences.reduce((sum, c) => sum + c, 0) / confidences.length,
        }
      : null;

  const hunks: SerializerHunkResult[] = [];
  for (const { result, label } of items) {
    hunks.push({
      hunkId: result.hunkId,
      actualDefect: label.defect,
      defectScoreRaw: result.defectScore,
      defectScoreNormalized: normalizeScore(result.defectScore),
      defectConfidence: result.defectConfidence,
      defectProbabilities: result.defectProbabilities,
      touchesPublicApi: result.touchesPublicApi,
      touchesPublicApiLabel: label.touchesPublicApi,
      touchesSecurity: result.touchesSecurity,
      touchesSecurityLabel: label.touchesSecurity,
      requestId: result.requestId,
      error: null,
    });
  }
  for (const failure of run.failures) {
    const label = labelsByHunkId[failure.hunkId];
    if (!label) {
      continue; // No label to report against; nothing meaningful to attach.
    }
    hunks.push({
      hunkId: failure.hunkId,
      actualDefect: label.defect,
      defectScoreRaw: null,
      defectScoreNormalized: null,
      defectConfidence: null,
      defectProbabilities: null,
      touchesPublicApi: null,
      touchesPublicApiLabel: label.touchesPublicApi,
      touchesSecurity: null,
      touchesSecurityLabel: label.touchesSecurity,
      requestId: null,
      error: failure.error,
    });
  }

  return {
    serializer,
    sampleCount: items.length,
    sweep,
    bestThreshold: best.threshold,
    bestMetrics: best,
    ece,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    tokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd: (inputTokens / 1_000_000) * costPerMTokInputUsd,
    h0: h0Verdict({ recall: best.recall, f1: best.f1 }, h0Criteria),
    confidence,
    hunks,
  };
}

/**
 * Cross-serializer agreement: for each hunk that succeeded in every
 * reported serializer, whether they all predict the same outcome
 * (defect/benign) at each serializer's own best threshold.
 */
function computeAgreement(serializerReports: readonly SerializerReport[]): AgreementSummary {
  const serializerNames = serializerReports.map((r) => r.serializer);
  if (serializerNames.length === 0) {
    return { hunks: [], agreedCount: 0, totalCount: 0 };
  }

  const byHunk = new Map<string, Record<string, boolean>>();
  for (const report of serializerReports) {
    for (const hunk of report.hunks) {
      if (hunk.defectScoreNormalized === null) continue; // failed hunk: no prediction
      const predicted = hunk.defectScoreNormalized >= report.bestThreshold;
      const existing = byHunk.get(hunk.hunkId) ?? {};
      existing[report.serializer] = predicted;
      byHunk.set(hunk.hunkId, existing);
    }
  }

  const hunkEntries: HunkAgreementEntry[] = [];
  for (const [hunkId, predictions] of byHunk) {
    const hasAll = serializerNames.every((name) => name in predictions);
    if (!hasAll) continue;

    const values = serializerNames.map((name) => predictions[name]);
    const first = values[0];
    const agree = first !== undefined && values.every((v) => v === first);
    hunkEntries.push({
      hunkId,
      predictions,
      agree,
      agreedPrediction: agree && first !== undefined ? first : null,
    });
  }

  const agreedCount = hunkEntries.filter((h) => h.agree).length;
  return { hunks: hunkEntries, agreedCount, totalCount: hunkEntries.length };
}

export function buildSpikeReport(
  resultsBySerializer: Record<string, SerializerRunResult>,
  labelsByHunkId: Record<string, HunkRecordLabel>,
  options: BuildSpikeReportOptions = {},
): SpikeReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const h0Criteria = options.h0Criteria ?? DEFAULT_H0_CRITERIA;
  const costPerMTokInputUsd = options.costPerMTokInputUsd ?? DEFAULT_COST_PER_MTOK_INPUT_USD;
  const now = options.now ?? (() => new Date());
  const datasetVersion = options.datasetVersion ?? DEFAULT_DATASET_VERSION;

  const serializers = Object.entries(resultsBySerializer).map(([name, run]) =>
    buildSerializerReport(name, run, labelsByHunkId, thresholds, h0Criteria, costPerMTokInputUsd),
  );

  const agreement = computeAgreement(serializers);
  const overallVerdict: "PASS" | "FAIL" = serializers.some((s) => s.h0.verdict === "PASS")
    ? "PASS"
    : "FAIL";

  return {
    generatedAt: now().toISOString(),
    datasetVersion,
    serializers,
    agreement,
    overallVerdict,
  };
}

function formatEce(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatConfidence(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

interface ConsistentErrors {
  readonly misses: string[];
  readonly falsePositives: string[];
}

/** Hunks every serializer agrees on, where the shared prediction contradicts the label. */
function deriveConsistentErrors(report: SpikeReport): ConsistentErrors {
  const actualByHunk = new Map<string, boolean>();
  for (const s of report.serializers) {
    for (const hunk of s.hunks) {
      if (!actualByHunk.has(hunk.hunkId)) {
        actualByHunk.set(hunk.hunkId, hunk.actualDefect);
      }
    }
  }

  const misses: string[] = [];
  const falsePositives: string[] = [];
  for (const entry of report.agreement.hunks) {
    if (entry.agreedPrediction === null) continue;
    const actual = actualByHunk.get(entry.hunkId);
    if (actual === undefined) continue;
    if (actual && !entry.agreedPrediction) {
      misses.push(entry.hunkId);
    } else if (!actual && entry.agreedPrediction) {
      falsePositives.push(entry.hunkId);
    }
  }
  return { misses, falsePositives };
}

function renderIdList(ids: readonly string[]): string[] {
  const lines: string[] = [];
  const shown = ids.slice(0, CONSISTENT_ERRORS_DISPLAY_LIMIT);
  for (const id of shown) {
    lines.push(`- ${id}`);
  }
  const remaining = ids.length - shown.length;
  if (remaining > 0) {
    lines.push(`- (+${remaining} more)`);
  }
  return lines;
}

export function renderSpikeReportMarkdown(report: SpikeReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 0 spike report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Dataset version: ${report.datasetVersion}`);
  lines.push("");
  lines.push(
    "| Serializer | Best threshold | Precision | Recall | F1 | ECE (public API) | ECE (security) | p50 latency (ms) | p95 latency (ms) | Input tokens | Est. cost (USD) | H0 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.serializers) {
    lines.push(
      `| ${s.serializer} | ${s.bestThreshold.toFixed(2)} | ${s.bestMetrics.precision.toFixed(3)} | ` +
        `${s.bestMetrics.recall.toFixed(3)} | ${s.bestMetrics.f1.toFixed(3)} | ${formatEce(s.ece.touchesPublicApi)} | ` +
        `${formatEce(s.ece.touchesSecurity)} | ${s.latency.p50.toFixed(0)} | ${s.latency.p95.toFixed(0)} | ` +
        `${s.tokens.input} | ${s.estimatedCostUsd.toFixed(6)} | ${s.h0.verdict} |`,
    );
  }
  lines.push("");

  const failures = report.serializers.filter(
    (s) => s.h0.verdict === "FAIL" && s.h0.reasons.length > 0,
  );
  for (const s of failures) {
    lines.push(`- **${s.serializer}** FAIL: ${s.h0.reasons.join("; ")}`);
  }
  if (failures.length > 0) {
    lines.push("");
  }

  lines.push(
    report.overallVerdict === "PASS"
      ? "DECISION: continue — at least one serializer passed H0 (SPEC §4)."
      : "DECISION: pivot — no serializer passed H0 (SPEC §4); phase 1 does not start per SPEC §5.",
  );
  lines.push("");

  lines.push("## Confidence (defect_likelihood)");
  lines.push("");
  lines.push("| Serializer | p10 | p50 | p90 | mean |");
  lines.push("|---|---|---|---|---|");
  for (const s of report.serializers) {
    lines.push(
      `| ${s.serializer} | ${formatConfidence(s.confidence?.p10)} | ${formatConfidence(s.confidence?.p50)} | ` +
        `${formatConfidence(s.confidence?.p90)} | ${formatConfidence(s.confidence?.mean)} |`,
    );
  }
  lines.push("");

  const { misses, falsePositives } = deriveConsistentErrors(report);
  lines.push("## Consistent misses / consistent false positives");
  lines.push("");
  lines.push(
    `**Consistent misses** — actual defect, every serializer predicted benign (${misses.length}):`,
  );
  lines.push(...(misses.length > 0 ? renderIdList(misses) : ["- none"]));
  lines.push("");
  lines.push(
    `**Consistent false positives** — actual benign, every serializer predicted defect (${falsePositives.length}):`,
  );
  lines.push(...(falsePositives.length > 0 ? renderIdList(falsePositives) : ["- none"]));

  return lines.join("\n");
}
