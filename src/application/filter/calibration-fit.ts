/**
 * Fits a post-hoc calibration map (src/domain/calibration.ts) to labeled
 * probabilities. Three methods, from two parameters to none:
 *
 * - {@link fitPlatt}: logistic regression of the label on `logit(p)`, solved
 *   by Newton-Raphson (IRLS). Two parameters, slope and intercept.
 * - {@link fitIsotonic}: pool-adjacent-violators, the non-parametric one.
 * - {@link fitTemperature}: Platt with the intercept pinned at 0, one
 *   parameter, solved by 1-D Newton on the same log-likelihood.
 *
 * No dependency, no optimizer library: the log-likelihood of a logistic model
 * is concave, its Hessian is 2x2 (1x1 for temperature), and a handful of
 * Newton steps from the identity converge to machine precision. A ridge term
 * of 1e-6 keeps the Hessian invertible when the data is separable or a whole
 * sample carries one label, which is the difference between a finite map and
 * an `Infinity` written into a config file.
 *
 * Every fitter returns `{ method: "none" }` for an empty sample: there is
 * nothing to fit, and the identity is the honest answer.
 *
 * FITTING IS NOT EVALUATION. A map fitted and scored on the same points will
 * always look good — isotonic especially, since it can memorize a small
 * sample outright. The held-out numbers come from calibration-study.ts's
 * cross-validation, and those are the ones a verdict is allowed to use.
 */
import {
  type CalibrationKnot,
  type CalibrationMap,
  type CalibrationMethod,
  NO_CALIBRATION,
  logit,
  sigmoid,
} from "../../domain/calibration.js";

/** One labeled probability: what Jev answered, and whether the finding was real. */
export interface CalibrationPoint {
  readonly prob: number;
  readonly actual: boolean;
}

/** Newton steps. The fit converges in well under ten; the cap is a guard, not a budget. */
const MAX_NEWTON_ITERATIONS = 300;
/** Stops once the parameter step is smaller than this. */
const CONVERGENCE_TOL = 1e-12;
/** L2 ridge on the parameters, so separable data gives a large-but-finite fit. */
const RIDGE = 1e-6;
/** Guard rails on the fitted parameters; a value at a rail means the data was degenerate. */
const MAX_SLOPE = 1e3;
const MAX_INTERCEPT = 1e3;

export function fitCalibration(
  method: CalibrationMethod,
  points: readonly CalibrationPoint[],
): CalibrationMap {
  switch (method) {
    case "none":
      return NO_CALIBRATION;
    case "platt":
      return fitPlatt(points);
    case "isotonic":
      return fitIsotonic(points);
    case "temperature":
      return fitTemperature(points);
  }
}

/**
 * Logistic regression `sigmoid(a * logit(p) + b)` fitted by Newton-Raphson
 * from the identity (a = 1, b = 0). Each step solves the 2x2 ridge-regularized
 * system `(XᵀWX + λI) Δ = Xᵀ(y - μ) - λθ` in closed form — no matrix library
 * for a 2x2 inverse.
 */
export function fitPlatt(points: readonly CalibrationPoint[]): CalibrationMap {
  if (points.length === 0) {
    return NO_CALIBRATION;
  }
  const zs = points.map((p) => logit(p.prob));
  const ys = points.map((p) => (p.actual ? 1 : 0));

  let a = 1;
  let b = 0;
  for (let iteration = 0; iteration < MAX_NEWTON_ITERATIONS; iteration++) {
    // Gradient of the penalized log-likelihood, and the (negative) Hessian.
    let gradA = -RIDGE * a;
    let gradB = -RIDGE * b;
    let hAA = RIDGE;
    let hAB = 0;
    let hBB = RIDGE;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i] as number;
      const y = ys[i] as number;
      const mu = sigmoid(a * z + b);
      const residual = y - mu;
      gradA += residual * z;
      gradB += residual;
      const w = mu * (1 - mu);
      hAA += w * z * z;
      hAB += w * z;
      hBB += w;
    }

    const det = hAA * hBB - hAB * hAB;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) {
      break;
    }
    const stepA = (hBB * gradA - hAB * gradB) / det;
    const stepB = (hAA * gradB - hAB * gradA) / det;
    a += stepA;
    b += stepB;
    if (Math.abs(stepA) < CONVERGENCE_TOL && Math.abs(stepB) < CONVERGENCE_TOL) {
      break;
    }
  }

  return {
    method: "platt",
    a: clamp(a, -MAX_SLOPE, MAX_SLOPE),
    b: clamp(b, -MAX_INTERCEPT, MAX_INTERCEPT),
  };
}

/**
 * Single-scalar temperature `sigmoid(logit(p) / t)`, fitted as a 1-D logistic
 * regression on the inverse temperature `w = 1 / t` (the log-likelihood is
 * concave in `w`, not in `t`) and inverted at the end. With no intercept it
 * can only sharpen or flatten around 0.5, so it is the control that shows how
 * much of Jev's miscalibration is a base-rate shift Platt's `b` has to absorb.
 */
export function fitTemperature(points: readonly CalibrationPoint[]): CalibrationMap {
  if (points.length === 0) {
    return NO_CALIBRATION;
  }
  const zs = points.map((p) => logit(p.prob));
  const ys = points.map((p) => (p.actual ? 1 : 0));

  let w = 1;
  for (let iteration = 0; iteration < MAX_NEWTON_ITERATIONS; iteration++) {
    let grad = -RIDGE * w;
    let hessian = RIDGE;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i] as number;
      const y = ys[i] as number;
      const mu = sigmoid(w * z);
      grad += (y - mu) * z;
      hessian += mu * (1 - mu) * z * z;
    }
    if (!Number.isFinite(hessian) || hessian < 1e-18) {
      break;
    }
    const step = grad / hessian;
    w += step;
    if (Math.abs(step) < CONVERGENCE_TOL) {
      break;
    }
  }

  // t must stay positive: a non-positive inverse temperature would flip the
  // ranking, which is the one thing a calibration map must never do.
  const bounded = clamp(w, 1 / MAX_SLOPE, MAX_SLOPE);
  return { method: "temperature", t: 1 / bounded };
}

/**
 * Pool-adjacent-violators: the monotone non-decreasing step function closest
 * (in weighted least squares) to the observed labels, ordered by probability.
 * Items sharing one probability are averaged into a single weighted point
 * first — they cannot be separated by a monotone map anyway.
 *
 * The step function is emitted as knots at each block's first and last
 * probability, so `applyCalibration` interpolates linearly ACROSS the gap
 * between two blocks instead of jumping. A step would map two findings a
 * thousandth apart to visibly different calibrated probabilities on the
 * strength of one label; the ramp keeps the map continuous, and it stays
 * monotone either way.
 */
export function fitIsotonic(points: readonly CalibrationPoint[]): CalibrationMap {
  if (points.length === 0) {
    return NO_CALIBRATION;
  }

  const byProb = new Map<number, { sum: number; count: number }>();
  for (const point of points) {
    const entry = byProb.get(point.prob) ?? { sum: 0, count: 0 };
    entry.sum += point.actual ? 1 : 0;
    entry.count += 1;
    byProb.set(point.prob, entry);
  }

  // Each block covers a contiguous run of probabilities and holds their
  // weighted mean label.
  interface Block {
    minX: number;
    maxX: number;
    sum: number;
    weight: number;
  }
  const blocks: Block[] = [];
  for (const prob of [...byProb.keys()].sort((a, b) => a - b)) {
    const entry = byProb.get(prob) as { sum: number; count: number };
    blocks.push({ minX: prob, maxX: prob, sum: entry.sum, weight: entry.count });
    // Pool backwards while the previous block's mean exceeds this one's.
    while (blocks.length > 1) {
      const current = blocks[blocks.length - 1] as Block;
      const previous = blocks[blocks.length - 2] as Block;
      if (previous.sum / previous.weight <= current.sum / current.weight) {
        break;
      }
      blocks.splice(blocks.length - 2, 2, {
        minX: previous.minX,
        maxX: current.maxX,
        sum: previous.sum + current.sum,
        weight: previous.weight + current.weight,
      });
    }
  }

  const knots: CalibrationKnot[] = [];
  for (const block of blocks) {
    const y = block.sum / block.weight;
    knots.push({ x: block.minX, y });
    if (block.maxX > block.minX) {
      knots.push({ x: block.maxX, y });
    }
  }
  return { method: "isotonic", knots };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? max : min;
  }
  return Math.min(max, Math.max(min, value));
}
