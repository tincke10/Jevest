/**
 * Metrics for the finding-filter H1 evaluation (SPEC §4.2, §5 Fase 1a):
 * threshold sweep on `is_real_defect` that also tracks how much noise gets
 * discarded, plus the H1 verdict. Built on top of `domain/metrics.ts`'s
 * generic confusion-matrix primitives — ECE is reused directly from there
 * by callers, not reimplemented here.
 */
import {
  type ConfusionMatrix,
  type H0VerdictResult,
  type ThresholdMetrics,
  f1 as computeF1,
  precision as computePrecision,
  recall as computeRecall,
  confusionMatrix,
} from "./metrics.js";

export interface FilterThresholdMetrics extends ThresholdMetrics {
  /** Of the actual noise (real=false), the fraction correctly discarded (predicted=false). */
  readonly noiseDiscardedRate: number;
}

/** tn / (tn + fp); 0 when there is no noise at all, never NaN. */
function noiseDiscardedRate(matrix: ConfusionMatrix): number {
  const denom = matrix.tn + matrix.fp;
  return denom === 0 ? 0 : matrix.tn / denom;
}

/**
 * Evaluates `is_real_defect`'s keep-score against a set of thresholds. A
 * finding is "kept" when `keepScore >= threshold` (inclusive boundary);
 * `real` is the H1 ground truth (line-overlap with the fix, SPEC §5).
 */
export function filterThresholdSweep(
  items: readonly { keepScore: number; real: boolean }[],
  thresholds: readonly number[],
): FilterThresholdMetrics[] {
  return thresholds.map((threshold) => {
    const matrix = confusionMatrix(
      items.map((item) => ({ predicted: item.keepScore >= threshold, actual: item.real })),
    );
    return {
      threshold,
      matrix,
      precision: computePrecision(matrix),
      recall: computeRecall(matrix),
      f1: computeF1(matrix),
      noiseDiscardedRate: noiseDiscardedRate(matrix),
    };
  });
}

export interface H1Criteria {
  readonly minRecall: number;
  readonly minNoiseDiscardedRate: number;
}

/** SPEC H1 (§4.2): recall >= minRecall AND noise discarded >= minNoiseDiscardedRate, both required. */
export function h1Verdict(
  metrics: { recall: number; noiseDiscardedRate: number },
  criteria: H1Criteria,
): H0VerdictResult {
  const reasons: string[] = [];
  if (metrics.recall < criteria.minRecall) {
    reasons.push(`recall ${metrics.recall.toFixed(3)} is below the required ${criteria.minRecall}`);
  }
  if (metrics.noiseDiscardedRate < criteria.minNoiseDiscardedRate) {
    reasons.push(
      `noise discarded rate ${metrics.noiseDiscardedRate.toFixed(3)} is below the required ${criteria.minNoiseDiscardedRate}`,
    );
  }
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}
