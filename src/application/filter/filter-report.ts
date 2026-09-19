import {
  type FilterThresholdMetrics,
  type H1Criteria,
  filterThresholdSweep,
  h1Verdict,
} from "../../domain/filter-metrics.js";
/**
 * Turns raw finding-filter results into the H1 evaluation report (SPEC
 * §4.2, §5 Fase 1a step 5): threshold sweep on `is_real_defect` (recall of
 * real findings kept, noise discarded, precision, F1), ECE, confidence
 * percentiles (over `severity`'s confidence — `is_real_defect` is a noul
 * and carries none), token/cost/latency totals, per-finding detail, and
 * the H1 verdict. Carries an optional `judge` slot so the LLM-judge
 * baseline (FR-8.3, H6) can be merged in later without changing the shape.
 */
import {
  type ConfidenceSummary,
  expectedCalibrationError,
  percentile,
  summarizeConfidence,
} from "../../domain/metrics.js";
import type { H0VerdictResult } from "../../domain/metrics.js";
import type { FindingFailure, FindingResult } from "./filter-runner.js";

const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);

/** SPEC §4.2 H1: recall >= 0.95, noise discarded >= 0.40. */
const DEFAULT_H1_CRITERIA: H1Criteria = { minRecall: 0.95, minNoiseDiscardedRate: 0.4 };

const DEFAULT_COST_PER_MTOK_INPUT_USD = 0.042;
const DEFAULT_DATASET_VERSION = 1;

export interface FilterFindingResult {
  readonly findingId: string;
  readonly actualReal: boolean;
  readonly isRealDefectProb: number | null;
  readonly severityRaw: number | null;
  readonly severityConfidence: number | null;
  readonly isStyleOnlyProb: number | null;
  readonly actionableProb: number | null;
  readonly requestId: string | null;
  readonly error: string | null;
}

/** Placeholder for the LLM-judge baseline (H6, FR-8.3), merged in once it exists. */
export interface JudgeBaseline {
  readonly provider: string;
  readonly model: string;
  readonly recall: number;
  readonly noiseDiscarded: number;
  readonly costUsd: number;
  readonly latencyP50: number;
}

export interface FilterReport {
  readonly generatedAt: string;
  readonly datasetVersion: number;
  readonly sampleCount: number;
  readonly findings: FilterFindingResult[];
  readonly sweep: FilterThresholdMetrics[];
  readonly bestThreshold: number;
  readonly bestMetrics: FilterThresholdMetrics;
  readonly ece: number | null;
  readonly confidence: ConfidenceSummary | null;
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly tokens: { readonly input: number; readonly output: number };
  readonly estimatedCostUsd: number;
  readonly h1: H0VerdictResult;
  readonly judge?: JudgeBaseline;
}

export interface FilterRunResultInput {
  readonly results: readonly FindingResult[];
  readonly failures: readonly FindingFailure[];
}

export interface BuildFilterReportOptions {
  readonly thresholds?: readonly number[];
  readonly h1Criteria?: H1Criteria;
  readonly costPerMTokInputUsd?: number;
  readonly now?: () => Date;
  readonly datasetVersion?: number;
  readonly judge?: JudgeBaseline;
}

interface LabeledFindingResult {
  readonly result: FindingResult;
  readonly real: boolean;
}

export function buildFilterReport(
  run: FilterRunResultInput,
  realByFindingId: Record<string, boolean>,
  options: BuildFilterReportOptions = {},
): FilterReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const h1Criteria = options.h1Criteria ?? DEFAULT_H1_CRITERIA;
  const costPerMTokInputUsd = options.costPerMTokInputUsd ?? DEFAULT_COST_PER_MTOK_INPUT_USD;
  const now = options.now ?? (() => new Date());
  const datasetVersion = options.datasetVersion ?? DEFAULT_DATASET_VERSION;

  const items: LabeledFindingResult[] = [];
  for (const result of run.results) {
    const real = realByFindingId[result.findingId];
    if (real !== undefined) {
      items.push({ result, real });
    }
  }

  const sweep = filterThresholdSweep(
    items.map(({ result, real }) => ({ keepScore: result.isRealDefectProb, real })),
    thresholds,
  );

  let best: FilterThresholdMetrics = sweep[0] ?? {
    threshold: 0.5,
    matrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
    precision: 0,
    recall: 0,
    f1: 0,
    noiseDiscardedRate: 0,
  };
  for (const candidate of sweep) {
    if (candidate.f1 > best.f1) best = candidate;
  }

  const ece =
    items.length > 0
      ? expectedCalibrationError(
          items.map(({ result, real }) => ({ prob: result.isRealDefectProb, actual: real })),
        )
      : null;

  const confidence = summarizeConfidence(items.map(({ result }) => result.severityConfidence));

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

  const findings: FilterFindingResult[] = [];
  for (const { result, real } of items) {
    findings.push({
      findingId: result.findingId,
      actualReal: real,
      isRealDefectProb: result.isRealDefectProb,
      severityRaw: result.severity,
      severityConfidence: result.severityConfidence,
      isStyleOnlyProb: result.isStyleOnlyProb,
      actionableProb: result.actionableProb,
      requestId: result.requestId,
      error: null,
    });
  }
  for (const failure of run.failures) {
    const real = realByFindingId[failure.findingId];
    if (real === undefined) continue;
    findings.push({
      findingId: failure.findingId,
      actualReal: real,
      isRealDefectProb: null,
      severityRaw: null,
      severityConfidence: null,
      isStyleOnlyProb: null,
      actionableProb: null,
      requestId: null,
      error: failure.error,
    });
  }

  return {
    generatedAt: now().toISOString(),
    datasetVersion,
    sampleCount: items.length,
    findings,
    sweep,
    bestThreshold: best.threshold,
    bestMetrics: best,
    ece,
    confidence,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    tokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd: (inputTokens / 1_000_000) * costPerMTokInputUsd,
    h1: h1Verdict({ recall: best.recall, noiseDiscardedRate: best.noiseDiscardedRate }, h1Criteria),
    ...(options.judge ? { judge: options.judge } : {}),
  };
}

function formatNullable(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

export function renderFilterReportMarkdown(report: FilterReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 1a finding-filter report (H1)");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Dataset version: ${report.datasetVersion}`);
  lines.push(`Sample size: ${report.sampleCount}`);
  lines.push("");
  lines.push("| Best threshold | Precision | Recall | F1 | Noise discarded | ECE | H1 |");
  lines.push("|---|---|---|---|---|---|---|");
  lines.push(
    `| ${report.bestThreshold.toFixed(2)} | ${report.bestMetrics.precision.toFixed(3)} | ` +
      `${report.bestMetrics.recall.toFixed(3)} | ${report.bestMetrics.f1.toFixed(3)} | ` +
      `${report.bestMetrics.noiseDiscardedRate.toFixed(3)} | ${formatNullable(report.ece)} | ${report.h1.verdict} |`,
  );
  lines.push("");
  lines.push(
    `Confidence (severity): p10=${formatNullable(report.confidence?.p10)} p50=${formatNullable(report.confidence?.p50)} ` +
      `p90=${formatNullable(report.confidence?.p90)} mean=${formatNullable(report.confidence?.mean)}`,
  );
  lines.push("");
  lines.push(
    `Cost: ${report.tokens.input} input tokens, $${report.estimatedCostUsd.toFixed(6)}. ` +
      `Latency p50=${report.latency.p50.toFixed(0)}ms p95=${report.latency.p95.toFixed(0)}ms.`,
  );
  lines.push("");

  if (report.judge) {
    lines.push("## LLM-judge baseline (H6)");
    lines.push("");
    lines.push("| Provider | Model | Recall | Noise discarded | Cost (USD) | p50 latency (ms) |");
    lines.push("|---|---|---|---|---|---|");
    lines.push(
      `| ${report.judge.provider} | ${report.judge.model} | ${report.judge.recall.toFixed(3)} | ` +
        `${report.judge.noiseDiscarded.toFixed(3)} | ${report.judge.costUsd.toFixed(4)} | ${report.judge.latencyP50.toFixed(0)} |`,
    );
    lines.push("");
  }

  if (report.h1.reasons.length > 0) {
    lines.push(`H1 reasons: ${report.h1.reasons.join("; ")}`);
    lines.push("");
  }

  lines.push(
    report.h1.verdict === "PASS"
      ? "DECISION: continue — H1 passed; the finding filter earns its place in phase 1b (SPEC §4.2)."
      : 'DECISION: pivot — H1 failed; Jev does not filter findings (SPEC §4.2 "si falla, Jev no aporta al review").',
  );

  return lines.join("\n");
}
