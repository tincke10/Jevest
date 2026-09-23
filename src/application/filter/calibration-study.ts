/**
 * The H3 calibration study (SPEC §4.2, §4.6.3): does a post-hoc map make
 * `is_real_defect` calibrated, and does it still hold on data it was not
 * fitted on?
 *
 * Both halves of that question matter, and the second is the one that kills
 * naive answers. Fitting a map and reporting the ECE of the same points is
 * circular — isotonic can drive it to near zero on any sample by memorizing
 * it. So every number here is HELD OUT:
 *
 * - stratified k-fold cross-validation inside the primary set: fit on k-1
 *   folds, score the fold that was left out, report the per-fold mean ± sd
 *   and the pooled ECE over every out-of-fold prediction;
 * - cross-set: fit on one whole set, score another whole set. The H1b
 *   reversed set (base rate 0.263) and the thorough set (base rate 0.028) have
 *   deliberately different distributions, so this is the honest generalization
 *   check, not a formality.
 *
 * AUC is reported for one reason: every map in domain/calibration.ts is
 * monotone, so the calibrated AUC must come out EXACTLY equal to the raw one.
 * If it ever does not, the map reordered findings and the study is wrong — H1
 * (recall at a threshold) is not something calibration is allowed to move.
 *
 * Pure: points in, report out. The CLI (scripts/filter/calibrate.ts) does the
 * replaying, the reading and the writing.
 */
import {
  CALIBRATION_METHODS,
  type CalibrationMap,
  type CalibrationMethod,
  applyCalibration,
} from "../../domain/calibration.js";
import {
  type ReliabilityBin,
  brierScore,
  expectedCalibrationError,
  reliabilityBins,
  rocAuc,
} from "../../domain/metrics.js";
import { mulberry32 } from "../spike/prng.js";
import { type CalibrationPoint, fitCalibration } from "./calibration-fit.js";

/** One oracle-labeled findings set, already replayed into (probability, label) pairs. */
export interface CalibrationSetInput {
  /** Short name used in every table and in `--primary`; usually the findings file's stem. */
  readonly name: string;
  readonly findingsPath: string;
  readonly hunksPath: string;
  readonly points: readonly CalibrationPoint[];
}

export interface CalibrationSetSummary {
  readonly name: string;
  readonly findingsPath: string;
  readonly hunksPath: string;
  readonly count: number;
  readonly realCount: number;
  readonly noiseCount: number;
  readonly baseRate: number;
  readonly rawEce: number;
  readonly rawBrier: number;
  readonly rawAuc: number | null;
}

export interface FoldScore {
  readonly fold: number;
  /** Held-out points scored in this fold. */
  readonly count: number;
  readonly ece: number;
  readonly brier: number;
}

export interface MethodResult {
  readonly method: CalibrationMethod;
  readonly folds: FoldScore[];
  /** Mean and population sd of the per-fold held-out ECE. */
  readonly eceMean: number;
  readonly eceSd: number;
  readonly brierMean: number;
  readonly brierSd: number;
  /** ECE over every out-of-fold prediction pooled into one sample — the verdict's number. */
  readonly pooledEce: number;
  readonly pooledBrier: number;
  /** AUC of the out-of-fold scores; a mixture of k maps, so it may drift a hair from the raw one. */
  readonly aucOutOfFold: number | null;
  /** AUC after the single full-sample map. */
  readonly aucCalibrated: number | null;
  /** True when {@link aucCalibrated} equals the raw AUC exactly. */
  readonly aucUnchanged: boolean;
  /**
   * The invariant that actually matters: no pair of findings swapped places.
   * A non-decreasing map can still POOL two probabilities into one value, and a
   * losing pair that becomes a tie counts as half a win, so the AUC can rise
   * without a single inversion — which is why the verdict checks this rather
   * than AUC equality.
   */
  readonly rankingPreserved: boolean;
  /** Distinct raw probabilities in the primary set. */
  readonly distinctRaw: number;
  /** Distinct calibrated probabilities under the full-sample map; fewer means the map pooled. */
  readonly distinctCalibrated: number;
  /** The map fitted on ALL of the primary set's points; what `--emit` writes. */
  readonly fittedOnAll: CalibrationMap;
}

export interface CrossSetResult {
  readonly method: CalibrationMethod;
  readonly fitOn: string;
  readonly evalOn: string;
  readonly count: number;
  readonly ece: number;
  readonly brier: number;
}

export interface CalibrationCriteria {
  /** Pooled out-of-fold ECE on the primary set must be below this (SPEC §4.2 H3: 0.1). */
  readonly maxPooledEce: number;
  /** Every cross-set ECE of the winning map must be below this. */
  readonly maxCrossSetEce: number;
}

/** H3's own bar for the held-out ECE, plus a deliberately looser cross-set bar. */
export const DEFAULT_CALIBRATION_CRITERIA: CalibrationCriteria = {
  maxPooledEce: 0.1,
  maxCrossSetEce: 0.15,
};

export const DEFAULT_FOLDS = 5;
export const DEFAULT_SEED = 20260923;
const DEFAULT_BINS = 10;

export interface BestMethod {
  readonly method: CalibrationMethod;
  readonly map: CalibrationMap;
  readonly pooledEce: number;
  readonly pooledBrier: number;
  /** Worst cross-set ECE among the pairs fitted on the primary set; null when there is no second set. */
  readonly worstCrossSetEce: number | null;
}

export interface CalibrationStudy {
  readonly generatedAt: string;
  readonly primarySet: string;
  readonly folds: number;
  readonly seed: number;
  readonly criteria: CalibrationCriteria;
  readonly sets: CalibrationSetSummary[];
  /** Cross-validated on the primary set, one entry per method. */
  readonly methods: MethodResult[];
  readonly crossSet: CrossSetResult[];
  readonly best: BestMethod;
  /** Primary set, raw probabilities. */
  readonly reliabilityBefore: ReliabilityBin[];
  /** Primary set, out-of-fold calibrated probabilities under the best method. */
  readonly reliabilityAfter: ReliabilityBin[];
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: string[];
}

export interface BuildCalibrationStudyOptions {
  readonly folds?: number;
  readonly seed?: number;
  readonly methods?: readonly CalibrationMethod[];
  readonly criteria?: CalibrationCriteria;
  readonly primarySet?: string;
  readonly bins?: number;
  readonly now?: () => Date;
}

/**
 * Stratified fold assignment: positives and negatives are shuffled separately
 * with a seeded PRNG and then dealt round-robin, so every fold carries the
 * set's base rate to within one item. On an n=209 set with 55 positives that
 * is not a nicety — an unstratified split can hand a fold 6 positives and
 * another 16, and the per-fold ECE then measures the split, not the map.
 *
 * Returns the fold index of each point, in input order.
 */
export function stratifiedFolds(
  points: readonly CalibrationPoint[],
  folds: number,
  seed: number,
): number[] {
  const assignment = new Array<number>(points.length).fill(0);
  const random = mulberry32(seed);

  for (const wanted of [true, false]) {
    const indices = points.flatMap((point, index) => (point.actual === wanted ? [index] : []));
    // Fisher-Yates with the shared stream, so both strata are one deterministic draw.
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = indices[i] as number;
      const b = indices[j] as number;
      indices[i] = b;
      indices[j] = a;
    }
    indices.forEach((pointIndex, position) => {
      assignment[pointIndex] = position % folds;
    });
  }

  return assignment;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation (the folds ARE the population, not a sample of one). */
function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function summarizeSet(set: CalibrationSetInput): CalibrationSetSummary {
  const realCount = set.points.filter((p) => p.actual).length;
  return {
    name: set.name,
    findingsPath: set.findingsPath,
    hunksPath: set.hunksPath,
    count: set.points.length,
    realCount,
    noiseCount: set.points.length - realCount,
    baseRate: set.points.length === 0 ? 0 : realCount / set.points.length,
    rawEce: expectedCalibrationError(set.points.map((p) => ({ prob: p.prob, actual: p.actual }))),
    rawBrier: brierScore(set.points.map((p) => ({ prob: p.prob, actual: p.actual }))),
    rawAuc: rocAuc(set.points.map((p) => ({ score: p.prob, actual: p.actual }))),
  };
}

function crossValidate(
  method: CalibrationMethod,
  points: readonly CalibrationPoint[],
  folds: number,
  seed: number,
  rawAuc: number | null,
): MethodResult {
  const assignment = stratifiedFolds(points, folds, seed);
  const outOfFold = new Array<number>(points.length).fill(0);
  const foldScores: FoldScore[] = [];

  for (let fold = 0; fold < folds; fold++) {
    const train = points.filter((_, i) => assignment[i] !== fold);
    const testIndices = points.flatMap((_, i) => (assignment[i] === fold ? [i] : []));
    const map = fitCalibration(method, train);
    const scored = testIndices.map((i) => {
      const point = points[i] as CalibrationPoint;
      const prob = applyCalibration(map, point.prob);
      outOfFold[i] = prob;
      return { prob, actual: point.actual };
    });
    foldScores.push({
      fold,
      count: scored.length,
      ece: expectedCalibrationError(scored),
      brier: brierScore(scored),
    });
  }

  const pooled = points.map((point, i) => ({
    prob: outOfFold[i] as number,
    actual: point.actual,
  }));
  const fittedOnAll = fitCalibration(method, points);
  const calibrated = points.map((point) => ({
    raw: point.prob,
    score: applyCalibration(fittedOnAll, point.prob),
    actual: point.actual,
  }));
  const aucCalibrated = rocAuc(calibrated);

  // Sorted by raw probability, the calibrated sequence must never step down.
  const sorted = [...calibrated].sort((a, b) => a.raw - b.raw);
  const rankingPreserved = sorted.every(
    (item, i) => i === 0 || item.score >= (sorted[i - 1] as { score: number }).score - 1e-12,
  );

  return {
    method,
    folds: foldScores,
    eceMean: mean(foldScores.map((f) => f.ece)),
    eceSd: standardDeviation(foldScores.map((f) => f.ece)),
    brierMean: mean(foldScores.map((f) => f.brier)),
    brierSd: standardDeviation(foldScores.map((f) => f.brier)),
    pooledEce: expectedCalibrationError(pooled),
    pooledBrier: brierScore(pooled),
    aucOutOfFold: rocAuc(pooled.map((p) => ({ score: p.prob, actual: p.actual }))),
    aucCalibrated,
    aucUnchanged:
      rawAuc === null || aucCalibrated === null
        ? rawAuc === aucCalibrated
        : Math.abs(rawAuc - aucCalibrated) < 1e-9,
    rankingPreserved,
    distinctRaw: new Set(points.map((p) => p.prob)).size,
    distinctCalibrated: new Set(calibrated.map((c) => c.score)).size,
    fittedOnAll,
  };
}

export function buildCalibrationStudy(
  sets: readonly CalibrationSetInput[],
  options: BuildCalibrationStudyOptions = {},
): CalibrationStudy {
  if (sets.length === 0) {
    throw new Error("a calibration study needs at least one labeled findings set");
  }
  const folds = options.folds ?? DEFAULT_FOLDS;
  const seed = options.seed ?? DEFAULT_SEED;
  const bins = options.bins ?? DEFAULT_BINS;
  const criteria = options.criteria ?? DEFAULT_CALIBRATION_CRITERIA;
  const methods = options.methods ?? CALIBRATION_METHODS;
  const now = options.now ?? (() => new Date());

  const primaryName = options.primarySet ?? (sets[0] as CalibrationSetInput).name;
  const primary = sets.find((set) => set.name === primaryName);
  if (!primary) {
    throw new Error(
      `--primary "${primaryName}" is not one of the given sets (${sets.map((s) => s.name).join(", ")})`,
    );
  }

  const summaries = sets.map(summarizeSet);
  const primarySummary = summaries.find((s) => s.name === primaryName) as CalibrationSetSummary;

  const methodResults = methods.map((method) =>
    crossValidate(method, primary.points, folds, seed, primarySummary.rawAuc),
  );

  const crossSet: CrossSetResult[] = [];
  for (const method of methods) {
    for (const fitSet of sets) {
      const map = fitCalibration(method, fitSet.points);
      for (const evalSet of sets) {
        if (evalSet.name === fitSet.name) continue;
        const scored = evalSet.points.map((point) => ({
          prob: applyCalibration(map, point.prob),
          actual: point.actual,
        }));
        crossSet.push({
          method,
          fitOn: fitSet.name,
          evalOn: evalSet.name,
          count: scored.length,
          ece: expectedCalibrationError(scored, bins),
          brier: brierScore(scored),
        });
      }
    }
  }

  const worstCrossSetEceOf = (method: CalibrationMethod): number | null => {
    const pairs = crossSet.filter((c) => c.method === method && c.fitOn === primaryName);
    return pairs.length === 0 ? null : Math.max(...pairs.map((c) => c.ece));
  };

  // Both halves of the verdict decide the winner, in the order they bind.
  // Among the methods that clear the held-out ECE bar — a bar met or missed,
  // not a score to maximize — the one that travels best to another
  // distribution wins, because generalization is what a shipped map lives or
  // dies on. If nothing clears the bar, the lowest pooled ECE wins so the
  // report still names the closest thing to a fix. Ties break towards the
  // earlier (simpler) method in CALIBRATION_METHODS.
  const clearing = methodResults.filter((m) => m.pooledEce < criteria.maxPooledEce);
  let bestResult = (clearing[0] ?? methodResults[0]) as MethodResult;
  for (const candidate of clearing.length > 0 ? clearing : methodResults) {
    if (clearing.length > 0) {
      const candidateCross = worstCrossSetEceOf(candidate.method) ?? Number.POSITIVE_INFINITY;
      const bestCross = worstCrossSetEceOf(bestResult.method) ?? Number.POSITIVE_INFINITY;
      if (candidateCross < bestCross) bestResult = candidate;
    } else if (candidate.pooledEce < bestResult.pooledEce) {
      bestResult = candidate;
    }
  }
  const bestCrossSet = crossSet.filter(
    (c) => c.method === bestResult.method && c.fitOn === primaryName,
  );
  const worstCrossSetEce =
    bestCrossSet.length === 0 ? null : Math.max(...bestCrossSet.map((c) => c.ece));

  const best: BestMethod = {
    method: bestResult.method,
    map: bestResult.fittedOnAll,
    pooledEce: bestResult.pooledEce,
    pooledBrier: bestResult.pooledBrier,
    worstCrossSetEce,
  };

  const reasons: string[] = [];
  if (bestResult.pooledEce >= criteria.maxPooledEce) {
    reasons.push(
      `pooled held-out ECE ${bestResult.pooledEce.toFixed(3)} (${bestResult.method}, ${folds}-fold on ${primaryName}) is not below the required ${criteria.maxPooledEce}`,
    );
  }
  if (worstCrossSetEce === null) {
    reasons.push(
      `no cross-set check: only one set (${primaryName}) was given, so nothing tested whether the map generalizes off its own distribution`,
    );
  } else if (worstCrossSetEce >= criteria.maxCrossSetEce) {
    const worst = bestCrossSet.reduce((a, b) => (a.ece >= b.ece ? a : b));
    reasons.push(
      `cross-set ECE ${worst.ece.toFixed(3)} (${worst.method} fitted on ${worst.fitOn}, scored on ${worst.evalOn}) is not below the required ${criteria.maxCrossSetEce}`,
    );
  }
  if (!bestResult.rankingPreserved) {
    reasons.push(
      `the ${bestResult.method} map reordered findings (a calibrated probability must be a monotone function of the raw one, or H1's recall at a threshold is no longer the measured one)`,
    );
  }

  const assignment = stratifiedFolds(primary.points, folds, seed);
  const outOfFoldBest = primary.points.map((point, i) => {
    const train = primary.points.filter((_, j) => assignment[j] !== assignment[i]);
    return {
      prob: applyCalibration(fitCalibration(bestResult.method, train), point.prob),
      actual: point.actual,
    };
  });

  return {
    generatedAt: now().toISOString(),
    primarySet: primaryName,
    folds,
    seed,
    criteria,
    sets: summaries,
    methods: methodResults,
    crossSet,
    best,
    reliabilityBefore: reliabilityBins(
      primary.points.map((p) => ({ prob: p.prob, actual: p.actual })),
      bins,
    ),
    reliabilityAfter: reliabilityBins(outOfFoldBest, bins),
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    reasons,
  };
}

function formatNullable(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function reliabilityTable(bins: readonly ReliabilityBin[]): string[] {
  const lines = ["| Bin | Mean predicted | Observed rate | Count |", "|---|---|---|---|"];
  for (const bin of bins) {
    lines.push(
      `| ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)} | ${
        bin.count === 0 ? "—" : bin.meanPredicted.toFixed(3)
      } | ${bin.count === 0 ? "—" : bin.observedRate.toFixed(3)} | ${bin.count} |`,
    );
  }
  return lines;
}

export function renderCalibrationStudyMarkdown(study: CalibrationStudy): string {
  const lines: string[] = [];
  lines.push("# Jevest post-hoc calibration study (H3)");
  lines.push("");
  lines.push(`Generated: ${study.generatedAt}`);
  lines.push(
    `Cross-validation: ${study.folds}-fold, stratified on the label, seed ${study.seed}. Primary set: \`${study.primarySet}\`.`,
  );
  lines.push(
    "Ground truth: the fix-aware oracle label (`label.oracle`); `unknown` findings are excluded. Jev answers are replayed from fixtures, so this run costs nothing.",
  );
  lines.push("");

  lines.push("## Sets");
  lines.push("");
  lines.push("| Set | Findings | N | Real | Noise | Base rate | Raw ECE | Raw Brier | Raw AUC |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const set of study.sets) {
    lines.push(
      `| \`${set.name}\` | \`${set.findingsPath}\` | ${set.count} | ${set.realCount} | ${set.noiseCount} | ` +
        `${set.baseRate.toFixed(3)} | ${set.rawEce.toFixed(3)} | ${set.rawBrier.toFixed(3)} | ${formatNullable(set.rawAuc)} |`,
    );
  }
  lines.push("");

  lines.push(`## Held-out cross-validation on \`${study.primarySet}\``);
  lines.push("");
  lines.push(
    "| Method | Held-out ECE (mean ± sd) | Pooled held-out ECE | Pooled held-out Brier | AUC (full-sample map) | Order kept | Distinct values |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const method of study.methods) {
    lines.push(
      `| ${method.method} | ${method.eceMean.toFixed(3)} ± ${method.eceSd.toFixed(3)} | ` +
        `${method.pooledEce.toFixed(3)} | ${method.pooledBrier.toFixed(3)} | ` +
        `${formatNullable(method.aucCalibrated)} | ${method.rankingPreserved ? "yes" : "NO"} | ` +
        `${method.distinctCalibrated} of ${method.distinctRaw} |`,
    );
  }
  lines.push("");
  lines.push(
    'Read the AUC column against the raw AUC in the table above. Platt and temperature are STRICTLY increasing, so theirs matches to the last digit — the map moved the probabilities and reordered nothing. Isotonic is only non-decreasing: it POOLS adjacent probabilities into one value, and a losing pair that becomes a tie counts as half a win, so its AUC can come out HIGHER without a single inversion. That is what the "distinct values" column measures, and why the verdict checks the order directly instead of trusting AUC equality. Pooling is not free either: findings that share a calibrated value can no longer be separated by any threshold downstream.',
  );
  lines.push("");

  if (study.crossSet.length > 0) {
    lines.push("## Cross-set generalization (fitted on one whole set, scored on another)");
    lines.push("");
    lines.push("| Method | Fitted on | Scored on | N | ECE | Brier |");
    lines.push("|---|---|---|---|---|---|");
    for (const cross of study.crossSet) {
      lines.push(
        `| ${cross.method} | \`${cross.fitOn}\` | \`${cross.evalOn}\` | ${cross.count} | ${cross.ece.toFixed(3)} | ${cross.brier.toFixed(3)} |`,
      );
    }
    lines.push("");
  }

  lines.push(`## Reliability (before — raw \`is_real_defect\` on \`${study.primarySet}\`)`);
  lines.push("");
  lines.push(...reliabilityTable(study.reliabilityBefore));
  lines.push("");
  lines.push(
    `## Reliability (after — out-of-fold \`${study.best.method}\` on \`${study.primarySet}\`)`,
  );
  lines.push("");
  lines.push(...reliabilityTable(study.reliabilityAfter));
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  lines.push(
    `Best method (lowest cross-set ECE among those clearing the held-out bar): **${study.best.method}** — pooled held-out ECE ${study.best.pooledEce.toFixed(3)}, ` +
      `pooled held-out Brier ${study.best.pooledBrier.toFixed(3)}, worst cross-set ECE ` +
      `${study.best.worstCrossSetEce === null ? "not measured" : study.best.worstCrossSetEce.toFixed(3)}.`,
  );
  lines.push("");
  lines.push(
    `Verdict: H3 ${study.verdict} (post-hoc, held-out) — requires pooled held-out ECE < ${study.criteria.maxPooledEce} on \`${study.primarySet}\` AND cross-set ECE < ${study.criteria.maxCrossSetEce}.`,
  );
  if (study.reasons.length > 0) {
    lines.push("");
    lines.push(`Reasons: ${study.reasons.join("; ")}`);
  }
  lines.push("");
  lines.push(
    "This verdict is about the CALIBRATED probability, not the raw one: SPEC §4.2's H3 on Jev's own output stays FAIL. Stage 4 applies a map only when `findingFilter.calibration: file` is set, and the default is `none`.",
  );

  return lines.join("\n");
}
