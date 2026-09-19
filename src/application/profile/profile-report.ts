/**
 * Turns raw surface-profile spike results into the H0' evaluation report
 * (SPEC §4.2, §5 Fase 0b): choice accuracy + per-class precision/recall/F1
 * for `change_kind`, threshold-swept precision/recall/F1 + ECE for each
 * noul, confidence percentiles, token/cost/latency totals, and the H0'
 * verdict — plus a Markdown render. H0' is informative only: it does not
 * gate phase 1b (SPEC §4.2 "H0' no bloquea").
 */
import {
  type ConfidenceSummary,
  type H0VerdictResult,
  type ThresholdMetrics,
  f1 as computeF1,
  precision as computePrecision,
  recall as computeRecall,
  confusionMatrix,
  expectedCalibrationError,
  percentile,
  summarizeConfidence,
  thresholdSweep,
} from "../../domain/metrics.js";
import { PROFILE_CHANGE_KINDS } from "../spike/question-sets/profile.js";
import type { ProfileChangeKind, ProfileLabels } from "./profile-label-record.js";
import type { ProfileHunkFailure, ProfileHunkResult } from "./profile-runner.js";

const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);

/** SPEC §4.2 H0': accuracy >= 0.90, each noul F1 >= 0.85, median confidence >= 0.5. */
export interface H0PrimeCriteria {
  readonly minAccuracy: number;
  readonly minNoulF1: number;
  readonly minMedianConfidence: number;
}

const DEFAULT_H0_PRIME_CRITERIA: H0PrimeCriteria = {
  minAccuracy: 0.9,
  minNoulF1: 0.85,
  minMedianConfidence: 0.5,
};

const DEFAULT_COST_PER_MTOK_INPUT_USD = 0.042;
const DEFAULT_DATASET_VERSION = 1;

const NOUL_NAMES = [
  "touches_public_api",
  "touches_error_handling",
  "touches_async",
  "touches_io",
] as const;
type NoulName = (typeof NOUL_NAMES)[number];

const NOUL_RESULT_FIELD: Record<NoulName, keyof ProfileHunkResult> = {
  touches_public_api: "touchesPublicApi",
  touches_error_handling: "touchesErrorHandling",
  touches_async: "touchesAsync",
  touches_io: "touchesIo",
};

const NOUL_LABEL_FIELD: Record<NoulName, keyof ProfileLabels> = {
  touches_public_api: "touchesPublicApi",
  touches_error_handling: "touchesErrorHandling",
  touches_async: "touchesAsync",
  touches_io: "touchesIo",
};

export interface ChoiceClassMetrics {
  readonly label: ProfileChangeKind;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly support: number;
}

export interface ChoiceReport {
  readonly accuracy: number;
  readonly perClass: ChoiceClassMetrics[];
}

export type { ConfidenceSummary };

export interface NoulReport {
  readonly name: NoulName;
  readonly sweep: ThresholdMetrics[];
  readonly bestThreshold: number;
  readonly bestMetrics: ThresholdMetrics;
  readonly ece: number;
}

export interface SerializerProfileReport {
  readonly serializer: string;
  readonly sampleCount: number;
  readonly changeKind: ChoiceReport;
  readonly changeKindConfidence: ConfidenceSummary | null;
  readonly nouls: NoulReport[];
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly tokens: { readonly input: number; readonly output: number };
  readonly estimatedCostUsd: number;
  readonly h0Prime: H0VerdictResult;
}

export interface ProfileSpikeReport {
  readonly generatedAt: string;
  readonly datasetVersion: number;
  readonly serializers: SerializerProfileReport[];
}

export interface ProfileSerializerRunResult {
  readonly results: readonly ProfileHunkResult[];
  readonly failures: readonly ProfileHunkFailure[];
}

export interface BuildProfileReportOptions {
  readonly thresholds?: readonly number[];
  readonly h0Criteria?: H0PrimeCriteria;
  readonly costPerMTokInputUsd?: number;
  readonly now?: () => Date;
  readonly datasetVersion?: number;
}

interface LabeledProfileResult {
  readonly result: ProfileHunkResult;
  readonly label: ProfileLabels;
}

function classMetrics(
  items: readonly LabeledProfileResult[],
  label: ProfileChangeKind,
): ChoiceClassMetrics {
  const matrix = confusionMatrix(
    items.map(({ result, label: l }) => ({
      predicted: result.changeKind === label,
      actual: l.changeKind === label,
    })),
  );
  const support = items.filter(({ label: l }) => l.changeKind === label).length;
  return {
    label,
    precision: computePrecision(matrix),
    recall: computeRecall(matrix),
    f1: computeF1(matrix),
    support,
  };
}

function buildChoiceReport(items: readonly LabeledProfileResult[]): ChoiceReport {
  const correct = items.filter(
    ({ result, label }) => result.changeKind === label.changeKind,
  ).length;
  const accuracy = items.length === 0 ? 0 : correct / items.length;
  const perClass = PROFILE_CHANGE_KINDS.map((kind) => classMetrics(items, kind));
  return { accuracy, perClass };
}

function buildNoulReport(
  items: readonly LabeledProfileResult[],
  name: NoulName,
  thresholds: readonly number[],
): NoulReport {
  const resultField = NOUL_RESULT_FIELD[name];
  const labelField = NOUL_LABEL_FIELD[name];

  const scoreItems = items.map(({ result, label }) => ({
    score: result[resultField] as number,
    actual: label[labelField] as boolean,
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
    if (candidate.f1 > best.f1) best = candidate;
  }

  const eceItems = items.map(({ result, label }) => ({
    prob: result[resultField] as number,
    actual: label[labelField] as boolean,
  }));

  return {
    name,
    sweep,
    bestThreshold: best.threshold,
    bestMetrics: best,
    ece: expectedCalibrationError(eceItems),
  };
}

function buildSerializerProfileReport(
  serializer: string,
  run: ProfileSerializerRunResult,
  labelsByHunkId: Record<string, ProfileLabels>,
  thresholds: readonly number[],
  h0Criteria: H0PrimeCriteria,
  costPerMTokInputUsd: number,
): SerializerProfileReport {
  const items: LabeledProfileResult[] = [];
  for (const result of run.results) {
    const label = labelsByHunkId[result.hunkId];
    if (label) items.push({ result, label });
  }

  const changeKind = buildChoiceReport(items);

  const changeKindConfidence: ConfidenceSummary | null = summarizeConfidence(
    items.map(({ result }) => result.changeKindConfidence),
  );

  const nouls = NOUL_NAMES.map((name) => buildNoulReport(items, name, thresholds));

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

  const reasons: string[] = [];
  if (changeKind.accuracy < h0Criteria.minAccuracy) {
    reasons.push(
      `change_kind accuracy ${changeKind.accuracy.toFixed(3)} is below the required ${h0Criteria.minAccuracy}`,
    );
  }
  for (const noul of nouls) {
    if (noul.bestMetrics.f1 < h0Criteria.minNoulF1) {
      reasons.push(
        `${noul.name} F1 ${noul.bestMetrics.f1.toFixed(3)} is below the required ${h0Criteria.minNoulF1}`,
      );
    }
  }
  const medianConfidence = changeKindConfidence?.p50 ?? 0;
  if (medianConfidence < h0Criteria.minMedianConfidence) {
    reasons.push(
      `median confidence ${medianConfidence.toFixed(3)} is below the required ${h0Criteria.minMedianConfidence}`,
    );
  }

  return {
    serializer,
    sampleCount: items.length,
    changeKind,
    changeKindConfidence,
    nouls,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    tokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd: (inputTokens / 1_000_000) * costPerMTokInputUsd,
    h0Prime: { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons },
  };
}

export function buildProfileReport(
  resultsBySerializer: Record<string, ProfileSerializerRunResult>,
  labelsByHunkId: Record<string, ProfileLabels>,
  options: BuildProfileReportOptions = {},
): ProfileSpikeReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const h0Criteria = options.h0Criteria ?? DEFAULT_H0_PRIME_CRITERIA;
  const costPerMTokInputUsd = options.costPerMTokInputUsd ?? DEFAULT_COST_PER_MTOK_INPUT_USD;
  const now = options.now ?? (() => new Date());
  const datasetVersion = options.datasetVersion ?? DEFAULT_DATASET_VERSION;

  const serializers = Object.entries(resultsBySerializer).map(([name, run]) =>
    buildSerializerProfileReport(
      name,
      run,
      labelsByHunkId,
      thresholds,
      h0Criteria,
      costPerMTokInputUsd,
    ),
  );

  return { generatedAt: now().toISOString(), datasetVersion, serializers };
}

export function renderProfileReportMarkdown(report: ProfileSpikeReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 0b surface-profile report (H0')");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Dataset version: ${report.datasetVersion}`);
  lines.push("");
  lines.push(
    "H0' is informative only and does not block phase 1b (SPEC §4.2): if it fails, the hunk-profile " +
      "stage degrades to path/size metadata and Jev is not called (FR-3.5).",
  );
  lines.push("");

  lines.push("## change_kind (choice)");
  lines.push("");
  lines.push("| Serializer | Accuracy | Median confidence |");
  lines.push("|---|---|---|");
  for (const s of report.serializers) {
    lines.push(
      `| ${s.serializer} | ${s.changeKind.accuracy.toFixed(3)} | ${(s.changeKindConfidence?.p50 ?? 0).toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push("| Serializer | Class | Precision | Recall | F1 | Support |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of report.serializers) {
    for (const c of s.changeKind.perClass) {
      lines.push(
        `| ${s.serializer} | ${c.label} | ${c.precision.toFixed(3)} | ${c.recall.toFixed(3)} | ${c.f1.toFixed(3)} | ${c.support} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Surface nouls");
  lines.push("");
  lines.push("| Serializer | Question | Best threshold | Precision | Recall | F1 | ECE |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of report.serializers) {
    for (const n of s.nouls) {
      lines.push(
        `| ${s.serializer} | ${n.name} | ${n.bestThreshold.toFixed(2)} | ${n.bestMetrics.precision.toFixed(3)} | ` +
          `${n.bestMetrics.recall.toFixed(3)} | ${n.bestMetrics.f1.toFixed(3)} | ${n.ece.toFixed(3)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Cost and H0' verdict");
  lines.push("");
  lines.push("| Serializer | Input tokens | Est. cost (USD) | p50 latency (ms) | H0’ |");
  lines.push("|---|---|---|---|---|");
  for (const s of report.serializers) {
    lines.push(
      `| ${s.serializer} | ${s.tokens.input} | ${s.estimatedCostUsd.toFixed(6)} | ${s.latency.p50.toFixed(0)} | ${s.h0Prime.verdict} |`,
    );
  }
  lines.push("");
  for (const s of report.serializers) {
    if (s.h0Prime.verdict === "FAIL") {
      lines.push(`- **${s.serializer}** FAIL: ${s.h0Prime.reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}
