import { describe, expect, it } from "vitest";
import {
  confusionMatrix,
  expectedCalibrationError,
  f1,
  h0Verdict,
  percentile,
  precision,
  recall,
  summarizeConfidence,
  thresholdSweep,
} from "./metrics.js";

describe("confusionMatrix", () => {
  it("counts true positives, false positives, true negatives, and false negatives", () => {
    const matrix = confusionMatrix([
      { predicted: true, actual: true }, // tp
      { predicted: true, actual: false }, // fp
      { predicted: false, actual: true }, // fn
      { predicted: false, actual: false }, // tn
      { predicted: true, actual: true }, // tp
    ]);
    expect(matrix).toEqual({ tp: 2, fp: 1, tn: 1, fn: 1 });
  });

  it("returns all zeros for an empty input", () => {
    expect(confusionMatrix([])).toEqual({ tp: 0, fp: 0, tn: 0, fn: 0 });
  });
});

describe("precision / recall / f1", () => {
  it("computes precision as tp / (tp + fp)", () => {
    expect(precision({ tp: 3, fp: 1, tn: 0, fn: 0 })).toBeCloseTo(0.75, 10);
  });

  it("returns 0 for precision when tp + fp is 0 (no positive predictions)", () => {
    expect(precision({ tp: 0, fp: 0, tn: 5, fn: 2 })).toBe(0);
  });

  it("computes recall as tp / (tp + fn)", () => {
    expect(recall({ tp: 3, fp: 0, tn: 0, fn: 1 })).toBeCloseTo(0.75, 10);
  });

  it("returns 0 for recall when tp + fn is 0 (no actual positives)", () => {
    expect(recall({ tp: 0, fp: 2, tn: 5, fn: 0 })).toBe(0);
  });

  it("computes f1 as the harmonic mean of precision and recall", () => {
    // precision=0.75, recall=0.75 -> f1=0.75
    expect(f1({ tp: 3, fp: 1, tn: 0, fn: 1 })).toBeCloseTo(0.75, 10);
  });

  it("returns 0 for f1 when precision and recall are both 0", () => {
    expect(f1({ tp: 0, fp: 0, tn: 5, fn: 5 })).toBe(0);
  });
});

describe("thresholdSweep", () => {
  const items = [
    { score: 0.9, actual: true },
    { score: 0.6, actual: true },
    { score: 0.4, actual: false },
    { score: 0.1, actual: false },
  ];

  it("predicts positive when score >= threshold (inclusive boundary)", () => {
    const [atBoundary] = thresholdSweep(items, [0.6]);
    // threshold 0.6: predicted true for 0.9 and 0.6, false for 0.4 and 0.1
    // actual: [true, true, false, false] -> tp=2, fp=0, tn=2, fn=0
    expect(atBoundary!.matrix).toEqual({ tp: 2, fp: 0, tn: 2, fn: 0 });
    expect(atBoundary!.precision).toBe(1);
    expect(atBoundary!.recall).toBe(1);
    expect(atBoundary!.f1).toBe(1);
  });

  it("sweeps multiple thresholds, one entry per threshold, in the given order", () => {
    const results = thresholdSweep(items, [0.5, 0.95]);
    expect(results.map((r) => r.threshold)).toEqual([0.5, 0.95]);
    // threshold 0.95: nothing predicted positive -> tp=0, fp=0, fn=2
    expect(results[1]!.matrix).toEqual({ tp: 0, fp: 0, tn: 2, fn: 2 });
    expect(results[1]!.precision).toBe(0);
    expect(results[1]!.recall).toBe(0);
  });

  it("returns an empty array for an empty threshold list", () => {
    expect(thresholdSweep(items, [])).toEqual([]);
  });
});

describe("h0Verdict", () => {
  it("passes when recall and f1 both meet the criteria", () => {
    const verdict = h0Verdict({ recall: 0.9, f1: 0.8 }, { minRecall: 0.85, minF1: 0.75 });
    expect(verdict).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("passes at the exact boundary (>=)", () => {
    const verdict = h0Verdict({ recall: 0.85, f1: 0.75 }, { minRecall: 0.85, minF1: 0.75 });
    expect(verdict.verdict).toBe("PASS");
  });

  it("fails and reports recall when only recall is short", () => {
    const verdict = h0Verdict({ recall: 0.8, f1: 0.8 }, { minRecall: 0.85, minF1: 0.75 });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/recall/i);
  });

  it("fails and reports both metrics when both are short", () => {
    const verdict = h0Verdict({ recall: 0.5, f1: 0.5 }, { minRecall: 0.85, minF1: 0.75 });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reasons).toHaveLength(2);
  });
});

describe("expectedCalibrationError", () => {
  it("is 0 for a perfectly calibrated set (confidence matches accuracy in every bin)", () => {
    // 10 items at prob 0.9, 9 of them actually true -> bin accuracy 0.9 == confidence 0.9
    const items = Array.from({ length: 10 }, (_, i) => ({ prob: 0.9, actual: i < 9 }));
    expect(expectedCalibrationError(items, 10)).toBeCloseTo(0, 10);
  });

  it("is 0 for an empty input", () => {
    expect(expectedCalibrationError([], 10)).toBe(0);
  });

  it("computes a hand-verifiable ECE for a simple two-bucket case", () => {
    // bin for prob in [0.0,0.1): 2 items, prob 0.05, both actual=false -> accuracy 0, |0.05-0|=0.05
    // bin for prob in [0.9,1.0]: 2 items, prob 0.95, both actual=true -> accuracy 1, |0.95-1|=0.05
    const items = [
      { prob: 0.05, actual: false },
      { prob: 0.05, actual: false },
      { prob: 0.95, actual: true },
      { prob: 0.95, actual: true },
    ];
    // weighted: 0.5 * 0.05 + 0.5 * 0.05 = 0.05
    expect(expectedCalibrationError(items, 10)).toBeCloseTo(0.05, 10);
  });

  it("clamps out-of-range probabilities into the nearest bin instead of throwing", () => {
    const items = [
      { prob: -0.1, actual: false },
      { prob: 1.1, actual: true },
    ];
    expect(() => expectedCalibrationError(items, 10)).not.toThrow();
  });
});

describe("percentile", () => {
  it("returns the single value for a one-element array at any percentile", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the exact element when the percentile lands on an index", () => {
    // sorted [100,200,300]: p50 -> idx=(50/100)*2=1 -> sorted[1]=200
    expect(percentile([300, 100, 200], 50)).toBe(200);
  });

  it("linearly interpolates between the two nearest ranks", () => {
    // sorted [10,20]: p50 -> idx=(50/100)*1=0.5 -> 10*0.5+20*0.5=15
    expect(percentile([10, 20], 50)).toBeCloseTo(15, 10);
  });

  it("does not mutate the input array", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("summarizeConfidence", () => {
  it("returns null for an empty array", () => {
    expect(summarizeConfidence([])).toBeNull();
  });

  it("computes p10/p50/p90/mean over the given values", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const summary = summarizeConfidence(values);
    expect(summary).not.toBeNull();
    expect(summary!.p10).toBeCloseTo(0.19, 10);
    expect(summary!.p50).toBeCloseTo(0.55, 10);
    expect(summary!.p90).toBeCloseTo(0.91, 10);
    expect(summary!.mean).toBeCloseTo(0.55, 10);
  });

  it("returns the single value for all percentiles and the mean with one element", () => {
    const summary = summarizeConfidence([0.42]);
    expect(summary).toEqual({ p10: 0.42, p50: 0.42, p90: 0.42, mean: 0.42 });
  });
});
