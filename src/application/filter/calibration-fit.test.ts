import { describe, expect, it } from "vitest";
import { applyCalibration, logit, sigmoid } from "../../domain/calibration.js";
import { expectedCalibrationError, rocAuc } from "../../domain/metrics.js";
import { fitCalibration, fitIsotonic, fitPlatt, fitTemperature } from "./calibration-fit.js";

interface Point {
  readonly prob: number;
  readonly actual: boolean;
}

/**
 * Deterministic synthetic sample: for each (reported probability, true rate)
 * pair, `count` items of which exactly `round(count * trueRate)` are positive.
 * No PRNG, so every expectation below is exact rather than "usually".
 */
function sample(
  pairs: readonly { reported: number; trueRate: number }[],
  count = 100,
): readonly Point[] {
  const points: Point[] = [];
  for (const { reported, trueRate } of pairs) {
    const positives = Math.round(count * trueRate);
    for (let i = 0; i < count; i++) {
      points.push({ prob: reported, actual: i < positives });
    }
  }
  return points;
}

const GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Already calibrated: what Jev reports IS the rate at which those findings are real. */
const CALIBRATED = sample(GRID.map((p) => ({ reported: p, trueRate: p })));

/**
 * Systematically overconfident by 1.5x in log-odds: the reported probability
 * is `sigmoid(1.5 * logit(trueRate))`, so 0.5 stays 0.5 and everything else is
 * pushed towards the extremes. The exact shape Platt is built to undo.
 */
const OVERCONFIDENT = sample(GRID.map((p) => ({ reported: sigmoid(1.5 * logit(p)), trueRate: p })));

describe("fitPlatt", () => {
  it("returns the identity (a = 1, b = 0) on an already calibrated sample", () => {
    const map = fitPlatt(CALIBRATED);
    expect(map.method).toBe("platt");
    if (map.method !== "platt") throw new Error("unreachable");
    expect(map.a).toBeCloseTo(1, 3);
    expect(map.b).toBeCloseTo(0, 3);
  });

  it("recovers the inverse slope of a systematically overconfident sample", () => {
    const map = fitPlatt(OVERCONFIDENT);
    if (map.method !== "platt") throw new Error("unreachable");
    expect(map.a).toBeCloseTo(1 / 1.5, 3);
    expect(map.b).toBeCloseTo(0, 3);
    // An overconfident 0.9 is pulled down towards the rate it really carries.
    const reported = sigmoid(1.5 * logit(0.9));
    expect(applyCalibration(map, reported)).toBeCloseTo(0.9, 3);
    expect(applyCalibration(map, reported)).toBeLessThan(reported);
  });

  it("shifts a sample whose probabilities all run above the base rate down towards it", () => {
    // Everything is reported at 0.7, only 30% is real: the fit must pull it below 0.5.
    const map = fitPlatt(sample([{ reported: 0.7, trueRate: 0.3 }], 200));
    expect(applyCalibration(map, 0.7)).toBeCloseTo(0.3, 2);
  });

  it("collapses the ECE of an overconfident sample", () => {
    const map = fitPlatt(OVERCONFIDENT);
    const before = expectedCalibrationError(OVERCONFIDENT.map((p) => ({ ...p })));
    const after = expectedCalibrationError(
      OVERCONFIDENT.map((p) => ({ prob: applyCalibration(map, p.prob), actual: p.actual })),
    );
    expect(before).toBeGreaterThan(0.06);
    expect(after).toBeLessThan(before / 10);
  });

  it("is the identity on an empty sample (nothing to fit)", () => {
    expect(fitPlatt([])).toEqual({ method: "none" });
  });

  it("stays finite when every item has the same label (separable data)", () => {
    const map = fitPlatt([
      { prob: 0.2, actual: true },
      { prob: 0.9, actual: true },
    ]);
    if (map.method !== "platt") throw new Error("unreachable");
    expect(Number.isFinite(map.a)).toBe(true);
    expect(Number.isFinite(map.b)).toBe(true);
  });
});

describe("fitTemperature", () => {
  it("returns t = 1 (the identity) on an already calibrated sample", () => {
    const map = fitTemperature(CALIBRATED);
    if (map.method !== "temperature") throw new Error("unreachable");
    expect(map.t).toBeCloseTo(1, 3);
  });

  it("returns t > 1 for an overconfident sample, flattening it towards 0.5", () => {
    const map = fitTemperature(OVERCONFIDENT);
    if (map.method !== "temperature") throw new Error("unreachable");
    expect(map.t).toBeCloseTo(1.5, 2);
    expect(applyCalibration(map, 0.99)).toBeLessThan(0.99);
  });

  it("cannot fix a pure base-rate bias, since it has no intercept", () => {
    // Everything reported at 0.7 but only 30% real: a temperature map can only
    // flatten towards 0.5, never below it, so a gap must remain.
    const points = sample([{ reported: 0.7, trueRate: 0.3 }], 200);
    const map = fitTemperature(points);
    expect(applyCalibration(map, 0.7)).toBeGreaterThan(0.45);
  });

  it("is the identity on an empty sample", () => {
    expect(fitTemperature([])).toEqual({ method: "none" });
  });
});

describe("fitIsotonic", () => {
  it("pools adjacent violators on a hand-written sequence", () => {
    // ys 0,1,0,1 -> the middle pair violates monotonicity and pools to 0.5.
    const map = fitIsotonic([
      { prob: 0.1, actual: false },
      { prob: 0.2, actual: true },
      { prob: 0.3, actual: false },
      { prob: 0.4, actual: true },
    ]);
    if (map.method !== "isotonic") throw new Error("unreachable");
    expect(map.knots).toEqual([
      { x: 0.1, y: 0 },
      { x: 0.2, y: 0.5 },
      { x: 0.3, y: 0.5 },
      { x: 0.4, y: 1 },
    ]);
  });

  it("averages the label of items sharing one probability before pooling", () => {
    const map = fitIsotonic([
      { prob: 0.5, actual: true },
      { prob: 0.5, actual: false },
      { prob: 0.5, actual: false },
      { prob: 0.5, actual: false },
    ]);
    if (map.method !== "isotonic") throw new Error("unreachable");
    expect(map.knots).toEqual([{ x: 0.5, y: 0.25 }]);
  });

  it("emits a non-decreasing knot list with a strictly increasing x", () => {
    const map = fitIsotonic(OVERCONFIDENT);
    if (map.method !== "isotonic") throw new Error("unreachable");
    for (let i = 1; i < map.knots.length; i++) {
      expect(map.knots[i]?.x).toBeGreaterThan(map.knots[i - 1]?.x as number);
      expect(map.knots[i]?.y).toBeGreaterThanOrEqual(map.knots[i - 1]?.y as number);
    }
  });

  it("recovers the true rate of each probability level it saw", () => {
    const map = fitIsotonic(OVERCONFIDENT);
    for (const p of GRID) {
      expect(applyCalibration(map, sigmoid(1.5 * logit(p)))).toBeCloseTo(p, 6);
    }
  });

  it("is the identity on an empty sample", () => {
    expect(fitIsotonic([])).toEqual({ method: "none" });
  });
});

describe("every fitted map", () => {
  // The AUC survives here because this sample's true rate rises with the
  // reported probability, so PAV has nothing to pool. On real data isotonic
  // DOES pool, and pooling turns a losing pair into a tie, which raises the
  // AUC without inverting anything — see calibration-study.test.ts.
  it("leaves the ranking untouched, and with it the AUC when nothing is pooled", () => {
    const scored = OVERCONFIDENT.map((p) => ({ score: p.prob, actual: p.actual }));
    const before = rocAuc(scored) as number;
    for (const map of [
      fitPlatt(OVERCONFIDENT),
      fitIsotonic(OVERCONFIDENT),
      fitTemperature(OVERCONFIDENT),
    ]) {
      const after = rocAuc(
        OVERCONFIDENT.map((p) => ({ score: applyCalibration(map, p.prob), actual: p.actual })),
      ) as number;
      expect(after).toBeCloseTo(before, 10);
    }
  });
});

describe("fitCalibration", () => {
  it("dispatches on the method name", () => {
    expect(fitCalibration("none", OVERCONFIDENT)).toEqual({ method: "none" });
    expect(fitCalibration("platt", OVERCONFIDENT).method).toBe("platt");
    expect(fitCalibration("isotonic", OVERCONFIDENT).method).toBe("isotonic");
    expect(fitCalibration("temperature", OVERCONFIDENT).method).toBe("temperature");
  });
});
