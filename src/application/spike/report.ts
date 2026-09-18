/**
 * Turns raw per-hunk spike results into the H0 evaluation report (SPEC §4,
 * §8 FR-8.2/FR-8.4): threshold sweep, best-F1 point, confusion matrix, ECE
 * for both nouls, latency percentiles, token/cost totals, and the H0
 * verdict — per serializer, plus a cross-serializer Markdown comparison.
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
import type { HunkResult } from "./spike-runner.js";

/** Sweep points at 5% steps from 0.05 to 0.95, inclusive. */
const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);

/** SPEC §4 H0 criteria: recall >= 0.85 and F1 >= 0.75. */
const DEFAULT_H0_CRITERIA: H0Criteria = { minRecall: 0.85, minF1: 0.75 };

/** SPEC §1: Jev pricing is $0.042/MTok input; output is free. */
const DEFAULT_COST_PER_MTOK_INPUT_USD = 0.042;

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
}

export interface SpikeReport {
  readonly generatedAt: string;
  readonly serializers: SerializerReport[];
  readonly overallVerdict: "PASS" | "FAIL";
}

export interface BuildSpikeReportOptions {
  /** Normalized (0..1) thresholds to sweep. Default: 0.05 steps from 0.05 to 0.95. */
  readonly thresholds?: readonly number[];
  readonly h0Criteria?: H0Criteria;
  readonly costPerMTokInputUsd?: number;
  /** Injectable clock for deterministic tests. Default: `() => new Date()`. */
  readonly now?: () => Date;
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
  results: readonly HunkResult[],
  labelsByHunkId: Record<string, HunkRecordLabel>,
  thresholds: readonly number[],
  h0Criteria: H0Criteria,
  costPerMTokInputUsd: number,
): SerializerReport {
  const items: LabeledResult[] = [];
  for (const result of results) {
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
  };
}

export function buildSpikeReport(
  resultsBySerializer: Record<string, readonly HunkResult[]>,
  labelsByHunkId: Record<string, HunkRecordLabel>,
  options: BuildSpikeReportOptions = {},
): SpikeReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const h0Criteria = options.h0Criteria ?? DEFAULT_H0_CRITERIA;
  const costPerMTokInputUsd = options.costPerMTokInputUsd ?? DEFAULT_COST_PER_MTOK_INPUT_USD;
  const now = options.now ?? (() => new Date());

  const serializers = Object.entries(resultsBySerializer).map(([name, results]) =>
    buildSerializerReport(
      name,
      results,
      labelsByHunkId,
      thresholds,
      h0Criteria,
      costPerMTokInputUsd,
    ),
  );

  const overallVerdict: "PASS" | "FAIL" = serializers.some((s) => s.h0.verdict === "PASS")
    ? "PASS"
    : "FAIL";

  return { generatedAt: now().toISOString(), serializers, overallVerdict };
}

function formatEce(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

export function renderSpikeReportMarkdown(report: SpikeReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 0 spike report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
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

  return lines.join("\n");
}
