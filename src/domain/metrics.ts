/**
 * Pure evaluation metrics for the H0 harness (SPEC §4, §8 FR-8.2). No I/O,
 * no SDK imports: these operate on plain in-memory arrays so they can be
 * reused by the spike report, the phase 1 eval harness, and unit tests
 * without any adapter.
 */

export interface PredictionPair {
  readonly predicted: boolean;
  readonly actual: boolean;
}

export interface ConfusionMatrix {
  readonly tp: number;
  readonly fp: number;
  readonly tn: number;
  readonly fn: number;
}

export function confusionMatrix(pairs: readonly PredictionPair[]): ConfusionMatrix {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { predicted, actual } of pairs) {
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
    else tn++;
  }
  return { tp, fp, tn, fn };
}

/** tp / (tp + fp); 0 when there are no positive predictions, never NaN. */
export function precision(matrix: ConfusionMatrix): number {
  const denom = matrix.tp + matrix.fp;
  return denom === 0 ? 0 : matrix.tp / denom;
}

/** tp / (tp + fn); 0 when there are no actual positives, never NaN. */
export function recall(matrix: ConfusionMatrix): number {
  const denom = matrix.tp + matrix.fn;
  return denom === 0 ? 0 : matrix.tp / denom;
}

/** Harmonic mean of precision and recall; 0 when both are 0, never NaN. */
export function f1(matrix: ConfusionMatrix): number {
  const p = precision(matrix);
  const r = recall(matrix);
  const denom = p + r;
  return denom === 0 ? 0 : (2 * p * r) / denom;
}

export interface ThresholdMetrics {
  readonly threshold: number;
  readonly matrix: ConfusionMatrix;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

/**
 * Evaluates a continuous score against a set of thresholds, one confusion
 * matrix per threshold. A score is predicted positive when `score >=
 * threshold` (inclusive boundary).
 */
export function thresholdSweep(
  items: readonly { score: number; actual: boolean }[],
  thresholds: readonly number[],
): ThresholdMetrics[] {
  return thresholds.map((threshold) => {
    const matrix = confusionMatrix(
      items.map((item) => ({ predicted: item.score >= threshold, actual: item.actual })),
    );
    return {
      threshold,
      matrix,
      precision: precision(matrix),
      recall: recall(matrix),
      f1: f1(matrix),
    };
  });
}

export interface H0Criteria {
  readonly minRecall: number;
  readonly minF1: number;
}

export interface H0VerdictResult {
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: string[];
}

/** SPEC H0 (§4): recall >= minRecall AND f1 >= minF1, both required to pass. */
export function h0Verdict(
  metrics: { recall: number; f1: number },
  criteria: H0Criteria,
): H0VerdictResult {
  const reasons: string[] = [];
  if (metrics.recall < criteria.minRecall) {
    reasons.push(`recall ${metrics.recall.toFixed(3)} is below the required ${criteria.minRecall}`);
  }
  if (metrics.f1 < criteria.minF1) {
    reasons.push(`F1 ${metrics.f1.toFixed(3)} is below the required ${criteria.minF1}`);
  }
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

/** One equal-width bucket of a reliability diagram; see {@link reliabilityBins}. */
export interface ReliabilityBin {
  /** Inclusive lower edge of the bucket. */
  readonly lower: number;
  /** Upper edge; inclusive only for the last bucket, which owns prob = 1. */
  readonly upper: number;
  readonly count: number;
  /** Mean predicted probability inside the bucket ("confidence"); 0 when empty. */
  readonly meanPredicted: number;
  /** Fraction of the bucket that is actually positive ("accuracy"); 0 when empty. */
  readonly observedRate: number;
}

/**
 * Reliability diagram for a binary probability: `bins` equal-width buckets
 * over [0, 1], each carrying its mean predicted probability and its observed
 * positive rate. Out-of-range probabilities are clamped into the nearest
 * bucket rather than throwing. Empty buckets are returned too (count 0), so a
 * report can print a fixed-height table.
 *
 * This is the binning {@link expectedCalibrationError} is defined on — ECE is
 * the count-weighted mean gap between `meanPredicted` and `observedRate` over
 * the non-empty buckets — so a reliability table and an ECE figure printed
 * side by side can never disagree.
 */
export function reliabilityBins(
  items: readonly { prob: number; actual: boolean }[],
  bins = 10,
): ReliabilityBin[] {
  const buckets = Array.from({ length: bins }, () => ({ sumProb: 0, sumActual: 0, count: 0 }));
  for (const { prob, actual } of items) {
    const clamped = Math.min(1, Math.max(0, prob));
    const index = Math.min(bins - 1, Math.floor(clamped * bins));
    const bucket = buckets[index];
    if (!bucket) {
      // Unreachable: index is always within [0, bins - 1].
      throw new Error("reliabilityBins: bucket index out of range");
    }
    bucket.sumProb += clamped;
    bucket.sumActual += actual ? 1 : 0;
    bucket.count += 1;
  }

  return buckets.map((bucket, index) => ({
    lower: index / bins,
    upper: (index + 1) / bins,
    count: bucket.count,
    meanPredicted: bucket.count === 0 ? 0 : bucket.sumProb / bucket.count,
    observedRate: bucket.count === 0 ? 0 : bucket.sumActual / bucket.count,
  }));
}

/**
 * Expected Calibration Error for a binary probability (e.g. a `noul` answer):
 * bins predictions into `bins` equal-width buckets over [0, 1], and for each
 * non-empty bucket compares its average predicted probability ("confidence")
 * against its actual positive rate ("accuracy"), weighting each bucket's
 * contribution by its share of the total sample count. Defined on
 * {@link reliabilityBins} so the number and the diagram share one binning.
 */
export function expectedCalibrationError(
  items: readonly { prob: number; actual: boolean }[],
  bins = 10,
): number {
  if (items.length === 0) {
    return 0;
  }

  let ece = 0;
  for (const bucket of reliabilityBins(items, bins)) {
    if (bucket.count === 0) continue;
    ece += (bucket.count / items.length) * Math.abs(bucket.meanPredicted - bucket.observedRate);
  }
  return ece;
}

/**
 * Brier score: the mean squared error of a probability against its 0/1
 * outcome. Lower is better, 0 is perfect, 0.25 is what always answering 0.5
 * gets. Unlike ECE it is a proper scoring rule — it punishes a map that buys
 * calibration by flattening every probability towards the base rate — so the
 * two are always reported together. 0 for an empty input, like
 * {@link expectedCalibrationError}.
 */
export function brierScore(items: readonly { prob: number; actual: boolean }[]): number {
  if (items.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const { prob, actual } of items) {
    const error = prob - (actual ? 1 : 0);
    sum += error * error;
  }
  return sum / items.length;
}

/**
 * Area under the ROC curve, computed as the Mann-Whitney statistic: the
 * probability that a randomly drawn positive outscores a randomly drawn
 * negative, with a tie counting as half. Ranking only, so ANY strictly
 * increasing map of the score leaves it untouched — which is exactly why a
 * calibration study reports it: it proves the map moved the probabilities
 * without reordering the findings. `null` when either class is missing, since
 * AUC is undefined there.
 */
export function rocAuc(items: readonly { score: number; actual: boolean }[]): number | null {
  const positives = items.filter((i) => i.actual).map((i) => i.score);
  const negatives = items.filter((i) => !i.actual).map((i) => i.score);
  if (positives.length === 0 || negatives.length === 0) {
    return null;
  }
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/**
 * Linear-interpolation percentile (0..100) over a set of values. Does not
 * mutate the input. Used for latency and confidence summaries wherever a
 * report needs p50/p95/p99-style figures.
 */
export function percentile(values: readonly number[], p: number): number {
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

export interface ConfidenceSummary {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly mean: number;
}

/**
 * p10/p50/p90/mean over a set of confidence values. `null` for an empty
 * set (nothing to summarize) rather than a zeroed-out summary, so callers
 * can distinguish "no data" from "data centered at 0".
 */
export function summarizeConfidence(values: readonly number[]): ConfidenceSummary | null {
  if (values.length === 0) {
    return null;
  }
  return {
    p10: percentile(values, 10),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
  };
}
