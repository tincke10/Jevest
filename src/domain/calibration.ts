/**
 * Post-hoc calibration of a `noul` probability (SPEC §4.2 H3, docs/BENCHMARK.md
 * "Post-hoc calibration study"): a monotone map from the probability Jev
 * answers to the probability the label actually supports.
 *
 * H3 asks for ECE < 0.1 on `is_real_defect` and every measured run FAILED —
 * Jev's probabilities run well above the true real rate (ECE 0.284 on the H1b
 * reversed set at a 26.3% base rate). A calibration map does not make Jev a
 * better judge: every method here is monotone non-decreasing, so the RANKING
 * of findings — and therefore AUC, recall at a rank cut, and H1 — is exactly
 * what it was. What it changes is the meaning of the number: the 0.8 that used
 * to mean "about half of these are real" starts meaning "about 80% of these
 * are real", which is the only thing a threshold in `.jevest.yml` can be read
 * against.
 *
 * Pure by design: no I/O, no clock, no config. Fitting lives in
 * application/filter/calibration-fit.ts, the study CLI in
 * scripts/filter/calibrate.ts, and the on-disk artifact is parsed here so the
 * pipeline, the action and the CLI all validate one shape.
 */
import { z } from "zod";

/**
 * Probabilities are clamped this far away from 0 and 1 before taking a logit,
 * so a confident answer of exactly 0 or 1 gives a finite (if large) log-odds
 * instead of an infinity that poisons every fit.
 */
export const PROB_EPSILON = 1e-4;

/**
 * A fitted monotone map from a raw probability to a calibrated one.
 *
 * - `none`: the identity. The default everywhere; also what an absent file means.
 * - `platt`: `sigmoid(a * logit(p) + b)`, two parameters — a slope that
 *   sharpens (a > 1) or flattens (a < 1) the log-odds and an intercept that
 *   shifts the whole curve towards the base rate.
 * - `isotonic`: pool-adjacent-violators, a step function turned into knots and
 *   interpolated linearly between them. The most flexible and the most prone
 *   to overfitting a small sample, which is why the study cross-validates.
 * - `temperature`: `sigmoid(logit(p) / t)`, one parameter. Platt with the
 *   intercept pinned at 0, so it can only sharpen or flatten, never shift.
 *   Useless against a pure base-rate bias, which is the honest control here.
 */
export type CalibrationMap =
  | { readonly method: "none" }
  | { readonly method: "platt"; readonly a: number; readonly b: number }
  | { readonly method: "isotonic"; readonly knots: readonly CalibrationKnot[] }
  | { readonly method: "temperature"; readonly t: number };

export interface CalibrationKnot {
  /** Raw probability. Strictly increasing across the knot list. */
  readonly x: number;
  /** Calibrated probability. Non-decreasing across the knot list. */
  readonly y: number;
}

export type CalibrationMethod = CalibrationMap["method"];

export const CALIBRATION_METHODS: readonly CalibrationMethod[] = [
  "none",
  "platt",
  "isotonic",
  "temperature",
];

/** The identity map. Stage 4's default, and what `calibration: "none"` resolves to. */
export const NO_CALIBRATION: CalibrationMap = { method: "none" };

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationError";
  }
}

/** Clamps a probability into [PROB_EPSILON, 1 - PROB_EPSILON]. */
export function clampProb(p: number): number {
  return Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, p));
}

/** Log-odds of a probability, clamped first so 0 and 1 stay finite. */
export function logit(p: number): number {
  const clamped = clampProb(p);
  return Math.log(clamped / (1 - clamped));
}

/** Inverse of {@link logit}. Never returns exactly 0 or 1 for a finite input. */
export function sigmoid(z: number): number {
  // Two branches so a large |z| never overflows exp().
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

const knotSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const calibrationMapSchema = z
  .discriminatedUnion("method", [
    z.object({ method: z.literal("none") }),
    z.object({ method: z.literal("platt"), a: z.number().finite(), b: z.number().finite() }),
    z.object({ method: z.literal("temperature"), t: z.number().positive().finite() }),
    z.object({ method: z.literal("isotonic"), knots: z.array(knotSchema).min(1) }),
  ])
  .superRefine((map, ctx) => {
    if (map.method !== "isotonic") return;
    for (let i = 1; i < map.knots.length; i++) {
      const previous = map.knots[i - 1] as CalibrationKnot;
      const current = map.knots[i] as CalibrationKnot;
      if (current.x <= previous.x) {
        ctx.addIssue({
          code: "custom",
          path: ["knots", i, "x"],
          message: `isotonic knots must have a strictly increasing x, got ${current.x} after ${previous.x}`,
        });
      }
      if (current.y < previous.y) {
        ctx.addIssue({
          code: "custom",
          path: ["knots", i, "y"],
          message: `isotonic knots must have a non-decreasing y (the map is monotone), got ${current.y} after ${previous.y}`,
        });
      }
    }
  });

/**
 * Maps a raw probability through the calibration map. Monotone
 * non-decreasing for every method, always lands in [0, 1], and throws on an
 * input outside [0, 1] rather than quietly extrapolating.
 */
export function applyCalibration(map: CalibrationMap, p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`probability must be between 0 and 1, got ${p}`);
  }
  switch (map.method) {
    case "none":
      return p;
    case "platt":
      return sigmoid(map.a * logit(p) + map.b);
    case "temperature":
      return sigmoid(logit(p) / map.t);
    case "isotonic":
      return interpolateKnots(map.knots, p);
  }
}

/**
 * Piecewise-linear lookup over the fitted knots, held constant outside the
 * fitted range: PAV says nothing about a probability it never saw, and a
 * straight extrapolation there would be inventing calibration out of thin air.
 */
function interpolateKnots(knots: readonly CalibrationKnot[], p: number): number {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (first === undefined || last === undefined) {
    // Unreachable: the schema requires at least one knot.
    throw new CalibrationError("an isotonic calibration map needs at least one knot");
  }
  if (p <= first.x) return first.y;
  if (p >= last.x) return last.y;
  for (let i = 1; i < knots.length; i++) {
    const left = knots[i - 1] as CalibrationKnot;
    const right = knots[i] as CalibrationKnot;
    if (p <= right.x) {
      const span = right.x - left.x;
      // The schema guarantees a strictly increasing x, so span > 0 here.
      const weight = (p - left.x) / span;
      return left.y + weight * (right.y - left.y);
    }
  }
  return last.y;
}

/**
 * Provenance of a fitted map, written next to it so nobody has to guess which
 * dataset and which run a number in `.jevest/calibration.json` came from.
 * Free-form on purpose: it is documentation, never read by the pipeline.
 */
export interface CalibrationFileMeta {
  readonly [key: string]: string | number | boolean | null;
}

/** Only `is_real_defect` is calibrated; SPEC §4.2 H3 is about that noul alone. */
export const CALIBRATED_QUESTION = "is_real_defect";
const CALIBRATION_FILE_VERSION = 1;

const calibrationFileSchema = z.object({
  version: z.literal(CALIBRATION_FILE_VERSION),
  question: z.literal(CALIBRATED_QUESTION),
  map: calibrationMapSchema,
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

/**
 * Parses a calibration artifact (`.jevest/calibration.json` in a consumer
 * repo, `config/calibration/is_real_defect.json` in this one) into its map.
 * Every failure — bad JSON, wrong version, another question, a non-monotone
 * isotonic knot list — throws a {@link CalibrationError} naming `label`, the
 * same rule `.jevest.yml` and `.jevest/context.yml` follow: a calibration that
 * fails to parse must never silently become the identity.
 */
export function parseCalibrationFile(raw: string, label: string): CalibrationMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CalibrationError(
      `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const result = calibrationFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CalibrationError(`${label}: ${result.error.message}`);
  }
  return result.data.map;
}

/** Serializes a map into the artifact {@link parseCalibrationFile} reads back. */
export function renderCalibrationFile(map: CalibrationMap, meta?: CalibrationFileMeta): string {
  return `${JSON.stringify(
    {
      version: CALIBRATION_FILE_VERSION,
      question: CALIBRATED_QUESTION,
      map,
      ...(meta ? { meta } : {}),
    },
    null,
    2,
  )}\n`;
}
