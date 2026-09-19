import { describe, expect, it } from "vitest";
import { filterThresholdSweep, h1Verdict } from "./filter-metrics.js";

// 4 real findings (scores .9 .8 .3 .7), 6 noise findings (scores .2 .1 .6 .05 .4 .15)
const items = [
  { keepScore: 0.9, real: true },
  { keepScore: 0.8, real: true },
  { keepScore: 0.3, real: true },
  { keepScore: 0.7, real: true },
  { keepScore: 0.2, real: false },
  { keepScore: 0.1, real: false },
  { keepScore: 0.6, real: false },
  { keepScore: 0.05, real: false },
  { keepScore: 0.4, real: false },
  { keepScore: 0.15, real: false },
];

describe("filterThresholdSweep", () => {
  it("computes recall, precision, F1, and noise-discarded rate at a given threshold", () => {
    const [metrics] = filterThresholdSweep(items, [0.5]);
    // kept (score>=0.5): reals .9 .8 .7 (3/4), noise .6 (1/6)
    // tp=3, fn=1, fp=1, tn=5
    expect(metrics!.matrix).toEqual({ tp: 3, fp: 1, fn: 1, tn: 5 });
    expect(metrics!.recall).toBeCloseTo(0.75, 10);
    expect(metrics!.precision).toBeCloseTo(0.75, 10);
    expect(metrics!.f1).toBeCloseTo(0.75, 10);
    expect(metrics!.noiseDiscardedRate).toBeCloseTo(5 / 6, 10);
  });

  it("discards all noise and keeps no real findings at threshold 1 when no score reaches it", () => {
    const [metrics] = filterThresholdSweep(items, [1]);
    expect(metrics!.matrix).toEqual({ tp: 0, fp: 0, fn: 4, tn: 6 });
    expect(metrics!.recall).toBe(0);
    expect(metrics!.noiseDiscardedRate).toBe(1);
  });

  it("keeps everything at threshold 0, discarding no noise", () => {
    const [metrics] = filterThresholdSweep(items, [0]);
    expect(metrics!.matrix).toEqual({ tp: 4, fp: 6, fn: 0, tn: 0 });
    expect(metrics!.recall).toBe(1);
    expect(metrics!.noiseDiscardedRate).toBe(0);
  });

  it("returns 0 noise-discarded rate when there is no noise at all (never NaN)", () => {
    const allReal = [
      { keepScore: 0.9, real: true },
      { keepScore: 0.1, real: true },
    ];
    const [metrics] = filterThresholdSweep(allReal, [0.5]);
    expect(metrics!.noiseDiscardedRate).toBe(0);
  });

  it("sweeps multiple thresholds in order", () => {
    const results = filterThresholdSweep(items, [0.2, 0.9]);
    expect(results.map((r) => r.threshold)).toEqual([0.2, 0.9]);
  });
});

describe("h1Verdict", () => {
  it("passes when recall and noise-discarded rate both meet the criteria", () => {
    const verdict = h1Verdict(
      { recall: 0.96, noiseDiscardedRate: 0.5 },
      { minRecall: 0.95, minNoiseDiscardedRate: 0.4 },
    );
    expect(verdict).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("passes at the exact boundary", () => {
    const verdict = h1Verdict(
      { recall: 0.95, noiseDiscardedRate: 0.4 },
      { minRecall: 0.95, minNoiseDiscardedRate: 0.4 },
    );
    expect(verdict.verdict).toBe("PASS");
  });

  it("fails and reports recall when only recall is short", () => {
    const verdict = h1Verdict(
      { recall: 0.8, noiseDiscardedRate: 0.5 },
      { minRecall: 0.95, minNoiseDiscardedRate: 0.4 },
    );
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/recall/i);
  });

  it("fails and reports both metrics when both are short", () => {
    const verdict = h1Verdict(
      { recall: 0.5, noiseDiscardedRate: 0.1 },
      { minRecall: 0.95, minNoiseDiscardedRate: 0.4 },
    );
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reasons).toHaveLength(2);
  });
});
