import {
  type FilterThresholdMetrics,
  type H1Criteria,
  filterThresholdSweep,
  h1Verdict,
} from "../../domain/filter-metrics.js";
/**
 * Turns raw finding-filter results into the H1/H6/H3 evaluation report
 * (SPEC §4.2, §5 Fase 1a step 5): threshold sweep on `is_real_defect`
 * (recall of real findings kept, noise discarded, precision, F1), ECE with
 * its sample size (H3 asks for >= 200 labeled findings; below that the
 * number is indicative and the report says so), confidence percentiles
 * (over `severity`'s confidence — `is_real_defect` is a noul and carries
 * none), token/cost/latency totals, per-finding detail, and the H1 verdict.
 *
 * Given an LLM-judge run (judge-runner.ts) over the same findings, it also
 * scores the judge at the SAME best threshold Jev got, sums the judge's
 * cost (nominal for claude-cli) and latency percentiles, and issues the H6
 * verdict: judge cost / Jev cost >= 100 AND judge recall - Jev recall <= 0.05.
 */
import {
  type ConfidenceSummary,
  expectedCalibrationError,
  percentile,
  summarizeConfidence,
} from "../../domain/metrics.js";
import type { H0VerdictResult } from "../../domain/metrics.js";
import type { FindingFailure, FindingResult } from "./filter-runner.js";
import type { JudgeFailure, JudgeResult } from "./judge-runner.js";

const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);

/** SPEC §4.2 H1: recall >= 0.95, noise discarded >= 0.40. */
const DEFAULT_H1_CRITERIA: H1Criteria = { minRecall: 0.95, minNoiseDiscardedRate: 0.4 };

export interface H6Criteria {
  /** Judge cost divided by Jev cost must be at least this. */
  readonly minCostRatio: number;
  /** Judge recall minus Jev recall must be at most this ("equivalent recall"). */
  readonly maxRecallGap: number;
}

/** SPEC §4.2 H6: >= 100x cheaper with equivalent recall. */
const DEFAULT_H6_CRITERIA: H6Criteria = { minCostRatio: 100, maxRecallGap: 0.05 };

export interface H3Criteria {
  readonly maxEce: number;
  readonly minSampleCount: number;
}

/** SPEC §4.2 H3: ECE < 0.1 over >= 200 labeled findings. */
const DEFAULT_H3_CRITERIA: H3Criteria = { maxEce: 0.1, minSampleCount: 200 };

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

/** Raw LLM-judge run over the same findings (judge-runner.ts), scored here. */
export interface JudgeRunInput {
  readonly provider: string;
  readonly results: readonly JudgeResult[];
  readonly failures: readonly JudgeFailure[];
}

/** The LLM-judge baseline (H6, FR-8.3), scored at Jev's best threshold. */
export interface JudgeBaseline {
  readonly provider: string;
  readonly model: string;
  /** Judged findings with ground truth (failures excluded). */
  readonly sampleCount: number;
  readonly failures: number;
  /** Jev's best threshold, applied to the judge's probability too. */
  readonly threshold: number;
  readonly recall: number;
  readonly precision: number;
  readonly noiseDiscarded: number;
  /** Sum over judge calls; nominal (subscription) for claude-cli. */
  readonly costUsd: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
}

export interface H6Result {
  /** judge cost / Jev cost; null when Jev's cost is zero (nothing to compare). */
  readonly costRatio: number | null;
  /** judge recall - Jev recall at the same threshold. */
  readonly recallGap: number;
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: string[];
}

export interface H3Result {
  readonly ece: number | null;
  readonly sampleCount: number;
  readonly meetsSampleSize: boolean;
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: string[];
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
  readonly h3: H3Result;
  readonly judge?: JudgeBaseline;
  readonly h6?: H6Result;
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
  readonly judgeRun?: JudgeRunInput;
  readonly h6Criteria?: H6Criteria;
  readonly h3Criteria?: H3Criteria;
}

interface LabeledFindingResult {
  readonly result: FindingResult;
  readonly real: boolean;
}

function h3Verdict(ece: number | null, sampleCount: number, criteria: H3Criteria): H3Result {
  const reasons: string[] = [];
  const meetsSampleSize = sampleCount >= criteria.minSampleCount;
  if (!meetsSampleSize) {
    reasons.push(
      `N = ${sampleCount} labeled findings is below the ${criteria.minSampleCount} SPEC §4.2 asks for; ECE is indicative, not a verdict`,
    );
  }
  if (ece === null) {
    reasons.push("no scored findings, ECE undefined");
  } else if (ece >= criteria.maxEce) {
    reasons.push(`ECE ${ece.toFixed(3)} is not below the required ${criteria.maxEce}`);
  }
  return {
    ece,
    sampleCount,
    meetsSampleSize,
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    reasons,
  };
}

function scoreJudge(
  judgeRun: JudgeRunInput,
  realByFindingId: Record<string, boolean>,
  threshold: number,
): JudgeBaseline {
  const scored: { keepScore: number; real: boolean }[] = [];
  const latencies: number[] = [];
  let costUsd = 0;
  let model = "";
  for (const result of judgeRun.results) {
    const real = realByFindingId[result.findingId];
    if (real === undefined) continue;
    scored.push({ keepScore: result.isRealDefectProb, real });
    latencies.push(result.latencyMs);
    costUsd += result.costUsd;
    model = model || result.model;
  }
  const [metrics] = filterThresholdSweep(scored, [threshold]);
  return {
    provider: judgeRun.provider,
    model,
    sampleCount: scored.length,
    failures: judgeRun.failures.length,
    threshold,
    recall: metrics?.recall ?? 0,
    precision: metrics?.precision ?? 0,
    noiseDiscarded: metrics?.noiseDiscardedRate ?? 0,
    costUsd,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
  };
}

function h6Verdict(
  judge: JudgeBaseline,
  jev: { recall: number; costUsd: number },
  criteria: H6Criteria,
): H6Result {
  const reasons: string[] = [];
  const costRatio = jev.costUsd > 0 ? judge.costUsd / jev.costUsd : null;
  const recallGap = judge.recall - jev.recall;
  if (costRatio === null) {
    reasons.push("Jev cost is zero (dry-run or no priced tokens), so the cost ratio is undefined");
  } else if (costRatio < criteria.minCostRatio) {
    reasons.push(
      `cost ratio ${costRatio.toFixed(1)}x is below the required ${criteria.minCostRatio}x`,
    );
  }
  if (recallGap > criteria.maxRecallGap) {
    reasons.push(
      `judge recall ${judge.recall.toFixed(3)} exceeds Jev recall ${jev.recall.toFixed(3)} by ${recallGap.toFixed(3)}, more than the allowed ${criteria.maxRecallGap}`,
    );
  }
  return { costRatio, recallGap, verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

export function buildFilterReport(
  run: FilterRunResultInput,
  realByFindingId: Record<string, boolean>,
  options: BuildFilterReportOptions = {},
): FilterReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const h1Criteria = options.h1Criteria ?? DEFAULT_H1_CRITERIA;
  const h6Criteria = options.h6Criteria ?? DEFAULT_H6_CRITERIA;
  const h3Criteria = options.h3Criteria ?? DEFAULT_H3_CRITERIA;
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

  const estimatedCostUsd = (inputTokens / 1_000_000) * costPerMTokInputUsd;
  const judge = options.judgeRun
    ? scoreJudge(options.judgeRun, realByFindingId, best.threshold)
    : undefined;
  const h6 = judge
    ? h6Verdict(judge, { recall: best.recall, costUsd: estimatedCostUsd }, h6Criteria)
    : undefined;

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
    estimatedCostUsd,
    h1: h1Verdict({ recall: best.recall, noiseDiscardedRate: best.noiseDiscardedRate }, h1Criteria),
    h3: h3Verdict(ece, items.length, h3Criteria),
    ...(judge ? { judge } : {}),
    ...(h6 ? { h6 } : {}),
  };
}

function formatNullable(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

export function renderFilterReportMarkdown(report: FilterReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 1a finding-filter report (H1 / H6 / H3)");
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

  lines.push("## Calibration (H3)");
  lines.push("");
  lines.push(
    `ECE of is_real_defect: ${formatNullable(report.h3.ece)} over N = ${report.h3.sampleCount} labeled findings. H3: ${report.h3.verdict}.`,
  );
  if (report.h3.reasons.length > 0) {
    lines.push(`H3 reasons: ${report.h3.reasons.join("; ")}`);
  }
  lines.push("");

  if (report.judge && report.h6) {
    lines.push("## LLM-judge baseline (H6)");
    lines.push("");
    lines.push(
      "| Side | Provider | Model | Threshold | Recall | Precision | Noise discarded | Cost (USD) | p50 (ms) | p95 (ms) |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    lines.push(
      `| Jev | typesafe | jev | ${report.bestThreshold.toFixed(2)} | ${report.bestMetrics.recall.toFixed(3)} | ` +
        `${report.bestMetrics.precision.toFixed(3)} | ${report.bestMetrics.noiseDiscardedRate.toFixed(3)} | ` +
        `${report.estimatedCostUsd.toFixed(6)} | ${report.latency.p50.toFixed(0)} | ${report.latency.p95.toFixed(0)} |`,
    );
    lines.push(
      `| Judge | ${report.judge.provider} | ${report.judge.model} | ${report.judge.threshold.toFixed(2)} | ` +
        `${report.judge.recall.toFixed(3)} | ${report.judge.precision.toFixed(3)} | ${report.judge.noiseDiscarded.toFixed(3)} | ` +
        `${report.judge.costUsd.toFixed(4)} | ${report.judge.latencyP50.toFixed(0)} | ${report.judge.latencyP95.toFixed(0)} |`,
    );
    lines.push("");
    const ratio = report.h6.costRatio === null ? "undefined" : `${report.h6.costRatio.toFixed(1)}x`;
    lines.push(
      `Judge sample: ${report.judge.sampleCount} findings (${report.judge.failures} failed). ` +
        `Cost ratio (judge / Jev): ${ratio}. Recall gap (judge - Jev): ${report.h6.recallGap.toFixed(3)}. H6: ${report.h6.verdict}.`,
    );
    if (report.h6.reasons.length > 0) {
      lines.push(`H6 reasons: ${report.h6.reasons.join("; ")}`);
    }
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
