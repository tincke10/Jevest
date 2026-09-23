import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  type CalibrationMap,
  NO_CALIBRATION,
  applyCalibration,
  calibrationMapSchema,
  logit,
  parseCalibrationFile,
  renderCalibrationFile,
  sigmoid,
} from "./calibration.js";

describe("logit / sigmoid", () => {
  it("round-trips a probability through logit and back", () => {
    for (const p of [0.01, 0.2, 0.5, 0.73, 0.99]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 10);
    }
  });

  it("clamps 0 and 1 instead of returning an infinite logit", () => {
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
    expect(logit(0)).toBeLessThan(-9);
    expect(logit(1)).toBeGreaterThan(9);
  });

  it("is 0 at p = 0.5", () => {
    expect(logit(0.5)).toBeCloseTo(0, 12);
    expect(sigmoid(0)).toBeCloseTo(0.5, 12);
  });
});

describe("applyCalibration", () => {
  it('leaves the probability untouched under method "none"', () => {
    for (const p of [0, 0.3, 0.5, 0.87, 1]) {
      expect(applyCalibration(NO_CALIBRATION, p)).toBe(p);
    }
  });

  it("applies a Platt map as sigmoid(a * logit(p) + b)", () => {
    const map: CalibrationMap = { method: "platt", a: 1, b: -1 };
    expect(applyCalibration(map, 0.5)).toBeCloseTo(sigmoid(-1), 12);
    expect(applyCalibration(map, 0.9)).toBeCloseTo(sigmoid(logit(0.9) - 1), 12);
  });

  it("is the identity for a Platt map with a = 1, b = 0", () => {
    const map: CalibrationMap = { method: "platt", a: 1, b: 0 };
    expect(applyCalibration(map, 0.73)).toBeCloseTo(0.73, 8);
  });

  it("applies a temperature map as sigmoid(logit(p) / t), flattening towards 0.5 for t > 1", () => {
    const map: CalibrationMap = { method: "temperature", t: 2 };
    expect(applyCalibration(map, 0.9)).toBeCloseTo(sigmoid(logit(0.9) / 2), 12);
    expect(applyCalibration(map, 0.9)).toBeLessThan(0.9);
    expect(applyCalibration(map, 0.1)).toBeGreaterThan(0.1);
    expect(applyCalibration(map, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("interpolates linearly between isotonic knots", () => {
    const map: CalibrationMap = {
      method: "isotonic",
      knots: [
        { x: 0.2, y: 0.1 },
        { x: 0.6, y: 0.5 },
      ],
    };
    expect(applyCalibration(map, 0.2)).toBeCloseTo(0.1, 12);
    expect(applyCalibration(map, 0.6)).toBeCloseTo(0.5, 12);
    expect(applyCalibration(map, 0.4)).toBeCloseTo(0.3, 12);
  });

  it("holds the end knots constant outside the fitted range", () => {
    const map: CalibrationMap = {
      method: "isotonic",
      knots: [
        { x: 0.2, y: 0.1 },
        { x: 0.6, y: 0.5 },
      ],
    };
    expect(applyCalibration(map, 0)).toBeCloseTo(0.1, 12);
    expect(applyCalibration(map, 1)).toBeCloseTo(0.5, 12);
  });

  it("returns the single knot's value everywhere when only one knot was fitted", () => {
    const map: CalibrationMap = { method: "isotonic", knots: [{ x: 0.4, y: 0.25 }] };
    expect(applyCalibration(map, 0.01)).toBeCloseTo(0.25, 12);
    expect(applyCalibration(map, 0.99)).toBeCloseTo(0.25, 12);
  });

  it("is monotone non-decreasing for every method, so it never reorders findings", () => {
    const maps: CalibrationMap[] = [
      NO_CALIBRATION,
      { method: "platt", a: 0.8, b: -1.4 },
      { method: "temperature", t: 3 },
      {
        method: "isotonic",
        knots: [
          { x: 0.1, y: 0 },
          { x: 0.5, y: 0.2 },
          { x: 0.9, y: 0.9 },
        ],
      },
    ];
    const probs = Array.from({ length: 101 }, (_, i) => i / 100);
    for (const map of maps) {
      const mapped = probs.map((p) => applyCalibration(map, p));
      for (let i = 1; i < mapped.length; i++) {
        expect(mapped[i]).toBeGreaterThanOrEqual((mapped[i - 1] as number) - 1e-12);
      }
    }
  });

  it("always lands inside [0, 1]", () => {
    const map: CalibrationMap = { method: "platt", a: 4, b: -8 };
    for (const p of [0, 0.001, 0.5, 0.999, 1]) {
      const calibrated = applyCalibration(map, p);
      expect(calibrated).toBeGreaterThanOrEqual(0);
      expect(calibrated).toBeLessThanOrEqual(1);
    }
  });

  it("throws on a probability outside [0, 1] rather than extrapolating nonsense", () => {
    expect(() => applyCalibration(NO_CALIBRATION, 1.2)).toThrow(RangeError);
    expect(() => applyCalibration({ method: "temperature", t: 2 }, -0.1)).toThrow(RangeError);
  });
});

describe("calibrationMapSchema", () => {
  it("accepts every method", () => {
    expect(calibrationMapSchema.parse({ method: "none" })).toEqual({ method: "none" });
    expect(calibrationMapSchema.parse({ method: "platt", a: 1, b: 0 })).toEqual({
      method: "platt",
      a: 1,
      b: 0,
    });
    expect(calibrationMapSchema.parse({ method: "temperature", t: 1.5 })).toEqual({
      method: "temperature",
      t: 1.5,
    });
  });

  it("rejects an unknown method", () => {
    expect(calibrationMapSchema.safeParse({ method: "spline" }).success).toBe(false);
  });

  it("rejects a non-positive temperature", () => {
    expect(calibrationMapSchema.safeParse({ method: "temperature", t: 0 }).success).toBe(false);
  });

  it("rejects isotonic knots whose x is not strictly increasing", () => {
    const result = calibrationMapSchema.safeParse({
      method: "isotonic",
      knots: [
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects isotonic knots whose y decreases (the map must stay monotone)", () => {
    const result = calibrationMapSchema.safeParse({
      method: "isotonic",
      knots: [
        { x: 0.2, y: 0.5 },
        { x: 0.6, y: 0.4 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a knot outside [0, 1]", () => {
    expect(
      calibrationMapSchema.safeParse({ method: "isotonic", knots: [{ x: 1.5, y: 0.5 }] }).success,
    ).toBe(false);
  });
});

describe("parseCalibrationFile", () => {
  const valid = JSON.stringify({
    version: 1,
    question: "is_real_defect",
    map: { method: "platt", a: 0.9, b: -1.2 },
    meta: { source: "datasets/findings-reversed-oracle.jsonl", fittedAt: "2026-09-23" },
  });

  it("returns the map of a valid file", () => {
    expect(parseCalibrationFile(valid, ".jevest/calibration.json")).toEqual({
      method: "platt",
      a: 0.9,
      b: -1.2,
    });
  });

  it("does not require the optional meta block", () => {
    const raw = JSON.stringify({ version: 1, question: "is_real_defect", map: { method: "none" } });
    expect(parseCalibrationFile(raw, "<file>")).toEqual({ method: "none" });
  });

  it("throws naming the source on invalid JSON", () => {
    expect(() => parseCalibrationFile("{not json", ".jevest/calibration.json")).toThrow(
      /\.jevest\/calibration\.json/,
    );
    expect(() => parseCalibrationFile("{not json", "<file>")).toThrow(CalibrationError);
  });

  it("throws on a file calibrating some other question", () => {
    const raw = JSON.stringify({ version: 1, question: "is_style_only", map: { method: "none" } });
    expect(() => parseCalibrationFile(raw, "<file>")).toThrow(CalibrationError);
  });

  it("throws on an unsupported version", () => {
    const raw = JSON.stringify({ version: 2, question: "is_real_defect", map: { method: "none" } });
    expect(() => parseCalibrationFile(raw, "<file>")).toThrow(CalibrationError);
  });

  it("round-trips a map through renderCalibrationFile", () => {
    const map: CalibrationMap = {
      method: "isotonic",
      knots: [
        { x: 0.1, y: 0 },
        { x: 0.8, y: 0.6 },
      ],
    };
    const rendered = renderCalibrationFile(map, { source: "test", fittedAt: "2026-09-23" });
    expect(parseCalibrationFile(rendered, "<file>")).toEqual(map);
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
