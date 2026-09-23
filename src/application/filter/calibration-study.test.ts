import { describe, expect, it } from "vitest";
import { applyCalibration, logit, sigmoid } from "../../domain/calibration.js";
import { rocAuc } from "../../domain/metrics.js";
import type { CalibrationPoint } from "./calibration-fit.js";
import {
  type CalibrationSetInput,
  buildCalibrationStudy,
  renderCalibrationStudyMarkdown,
  stratifiedFolds,
} from "./calibration-study.js";

/**
 * Deterministic overconfident sample: the reported probability is
 * `sigmoid(1.6 * logit(trueRate)) `, pushed further up by a base-rate shift, so
 * it needs both of Platt's parameters — exactly the shape H3 found on Jev.
 */
function overconfident(count = 40): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  for (const trueRate of [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    const reported = sigmoid(1.6 * logit(trueRate) + 1.2);
    const positives = Math.round(count * trueRate);
    for (let i = 0; i < count; i++) {
      points.push({ prob: reported, actual: i < positives });
    }
  }
  return points;
}

function set(name: string, points: readonly CalibrationPoint[]): CalibrationSetInput {
  return {
    name,
    findingsPath: `datasets/${name}.jsonl`,
    hunksPath: "datasets/hunks.jsonl",
    points,
  };
}

describe("stratifiedFolds", () => {
  const points: CalibrationPoint[] = [
    ...Array.from({ length: 20 }, () => ({ prob: 0.8, actual: true })),
    ...Array.from({ length: 80 }, () => ({ prob: 0.3, actual: false })),
  ];

  it("assigns every point to exactly one of the k folds", () => {
    const folds = stratifiedFolds(points, 5, 1234);
    expect(folds).toHaveLength(points.length);
    expect(new Set(folds)).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("keeps each fold's base rate within one item of the whole set's", () => {
    const folds = stratifiedFolds(points, 5, 1234);
    for (let fold = 0; fold < 5; fold++) {
      const inFold = points.filter((_, i) => folds[i] === fold);
      const positives = inFold.filter((p) => p.actual).length;
      expect(inFold).toHaveLength(20);
      expect(positives).toBe(4);
    }
  });

  it("is deterministic for a given seed and different for another", () => {
    expect(stratifiedFolds(points, 5, 1234)).toEqual(stratifiedFolds(points, 5, 1234));
    expect(stratifiedFolds(points, 5, 1234)).not.toEqual(stratifiedFolds(points, 5, 99));
  });
});

describe("buildCalibrationStudy", () => {
  const primary = set("reversed", overconfident());
  const other = set("thorough", overconfident(24));

  it("reports the raw ECE, Brier, base rate and AUC of every set", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    expect(study.sets).toHaveLength(2);
    const first = study.sets[0];
    expect(first?.name).toBe("reversed");
    expect(first?.count).toBe(primary.points.length);
    expect(first?.baseRate).toBeCloseTo(
      primary.points.filter((p) => p.actual).length / primary.points.length,
      10,
    );
    expect(first?.rawEce).toBeGreaterThan(0.1);
    expect(first?.rawAuc).toBeCloseTo(
      rocAuc(primary.points.map((p) => ({ score: p.prob, actual: p.actual }))) as number,
      10,
    );
  });

  it("takes the first set as primary unless one is named", () => {
    expect(buildCalibrationStudy([primary, other], { seed: 7 }).primarySet).toBe("reversed");
    expect(
      buildCalibrationStudy([primary, other], { seed: 7, primarySet: "thorough" }).primarySet,
    ).toBe("thorough");
  });

  it("throws when the named primary set was not given", () => {
    expect(() => buildCalibrationStudy([primary], { primarySet: "nope" })).toThrow(/nope/);
  });

  it("holds every method out of its own fit: k folds, each scored on unseen points", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7, folds: 5 });
    const platt = study.methods.find((m) => m.method === "platt");
    expect(platt?.folds).toHaveLength(5);
    expect(platt?.folds.reduce((sum, f) => sum + f.count, 0)).toBe(primary.points.length);
  });

  it("cuts the held-out ECE of an overconfident set with Platt and isotonic, but not with none", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    const byMethod = new Map(study.methods.map((m) => [m.method, m]));
    const raw = study.sets[0]?.rawEce as number;
    expect(byMethod.get("none")?.pooledEce).toBeCloseTo(raw, 10);
    expect(byMethod.get("platt")?.pooledEce).toBeLessThan(raw / 3);
    // Isotonic helps too, but less: it spends its freedom memorizing the
    // training folds, which is exactly what held-out scoring is here to expose.
    expect(byMethod.get("isotonic")?.pooledEce).toBeLessThan(raw / 2);
    expect(byMethod.get("isotonic")?.pooledEce).toBeGreaterThan(
      byMethod.get("platt")?.pooledEce as number,
    );
  });

  it("reports a fold standard deviation alongside the mean", () => {
    const platt = buildCalibrationStudy([primary, other], { seed: 7 }).methods.find(
      (m) => m.method === "platt",
    );
    expect(platt?.eceSd).toBeGreaterThanOrEqual(0);
    expect(platt?.eceMean).toBeGreaterThan(0);
  });

  it("confirms the full-sample map leaves the AUC exactly where it was", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    for (const method of study.methods) {
      expect(method.aucCalibrated).toBeCloseTo(study.sets[0]?.rawAuc as number, 10);
      expect(method.aucUnchanged).toBe(true);
      expect(method.rankingPreserved).toBe(true);
    }
  });

  it("counts how many distinct probabilities a method pools away", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    const none = study.methods.find((m) => m.method === "none");
    expect(none?.distinctCalibrated).toBe(none?.distinctRaw);
  });

  it("separates pooling from reordering: an isotonic tie raises the AUC but keeps the order", () => {
    // 0.55 is scored real, 0.60 is not: PAV must pool them into one block, and
    // a pair that used to be a loss becomes a tie — a higher AUC, no inversion.
    const pooling: CalibrationPoint[] = [
      ...Array.from({ length: 20 }, () => ({ prob: 0.2, actual: false })),
      { prob: 0.55, actual: true },
      { prob: 0.6, actual: false },
      ...Array.from({ length: 20 }, (_, i) => ({ prob: 0.9, actual: i < 18 })),
    ];
    const study = buildCalibrationStudy([set("pooling", pooling), other], { seed: 7 });
    const isotonic = study.methods.find((m) => m.method === "isotonic");
    expect(isotonic?.rankingPreserved).toBe(true);
    expect(isotonic?.aucUnchanged).toBe(false);
    expect(isotonic?.aucCalibrated).toBeGreaterThan(study.sets[0]?.rawAuc as number);
    expect(isotonic?.distinctCalibrated).toBeLessThan(isotonic?.distinctRaw as number);
    // Pooling is a property worth printing, never a reason to fail the verdict.
    expect(study.reasons.join(" ")).not.toMatch(/AUC/);
  });

  it("evaluates each method fitted on one set against the other, both ways", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    const pairs = study.crossSet.map((c) => `${c.method}:${c.fitOn}->${c.evalOn}`);
    expect(pairs).toContain("platt:reversed->thorough");
    expect(pairs).toContain("platt:thorough->reversed");
    expect(pairs).not.toContain("platt:reversed->reversed");
  });

  it("among the methods that clear the held-out bar, picks the one that travels best", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    const clearing = study.methods.filter((m) => m.pooledEce < study.criteria.maxPooledEce);
    expect(clearing.length).toBeGreaterThan(1);
    const worstCrossOf = (method: string): number =>
      Math.max(
        ...study.crossSet
          .filter((c) => c.method === method && c.fitOn === study.primarySet)
          .map((c) => c.ece),
      );
    const expected = clearing
      .map((m) => ({ method: m.method, cross: worstCrossOf(m.method) }))
      .reduce((a, b) => (a.cross <= b.cross ? a : b));
    expect(study.best.method).toBe(expected.method);
    expect(study.best.method).not.toBe("none");
  });

  it("falls back to the lowest pooled held-out ECE when no method clears the bar", () => {
    const study = buildCalibrationStudy([primary, other], {
      seed: 7,
      criteria: { maxPooledEce: 0.0001, maxCrossSetEce: 0.15 },
    });
    expect(study.best.pooledEce).toBeCloseTo(
      Math.min(...study.methods.map((m) => m.pooledEce)),
      12,
    );
  });

  it("passes H3 when the pooled held-out ECE and the cross-set ECE both clear the bar", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    expect(study.best.pooledEce).toBeLessThan(0.1);
    expect(study.verdict).toBe("PASS");
    expect(study.reasons).toEqual([]);
  });

  it("fails H3, naming the number, when the pooled held-out ECE misses the bar", () => {
    const study = buildCalibrationStudy([primary, other], {
      seed: 7,
      criteria: { maxPooledEce: 0.001, maxCrossSetEce: 0.15 },
    });
    expect(study.verdict).toBe("FAIL");
    expect(study.reasons.join(" ")).toMatch(/pooled held-out ECE/);
  });

  it("fails H3 when no second set was given, because generalization is untested", () => {
    const study = buildCalibrationStudy([primary], { seed: 7 });
    expect(study.verdict).toBe("FAIL");
    expect(study.reasons.join(" ")).toMatch(/cross-set/);
  });

  it("carries a before/after reliability table of ten bins for the best method", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    expect(study.reliabilityBefore).toHaveLength(10);
    expect(study.reliabilityAfter).toHaveLength(10);
    const counted = study.reliabilityAfter.reduce((sum, bin) => sum + bin.count, 0);
    expect(counted).toBe(primary.points.length);
  });

  it("fits the emitted map on every point of the primary set, not on a fold", () => {
    const study = buildCalibrationStudy([primary, other], { seed: 7 });
    const refit = study.methods.find((m) => m.method === study.best.method)?.fittedOnAll;
    expect(study.best.map).toEqual(refit);
    // Applying it must actually move an overconfident probability down.
    const highest = Math.max(...primary.points.map((p) => p.prob));
    expect(applyCalibration(study.best.map, highest)).toBeLessThan(highest);
  });
});

describe("renderCalibrationStudyMarkdown", () => {
  it("prints the verdict line, the method table and both reliability tables", () => {
    const study = buildCalibrationStudy(
      [set("reversed", overconfident()), set("thorough", overconfident(24))],
      {
        seed: 7,
      },
    );
    const markdown = renderCalibrationStudyMarkdown(study);
    expect(markdown).toContain("# Jevest post-hoc calibration study (H3)");
    expect(markdown).toContain("| Method | Held-out ECE (mean ± sd) |");
    expect(markdown).toContain("Verdict: H3 PASS");
    expect(markdown).toContain("Reliability (before");
    expect(markdown).toContain("Reliability (after");
    expect(markdown).toContain("platt");
  });

  it("prints the reasons on a FAIL", () => {
    const markdown = renderCalibrationStudyMarkdown(
      buildCalibrationStudy([set("reversed", overconfident())], { seed: 7 }),
    );
    expect(markdown).toContain("Verdict: H3 FAIL");
    expect(markdown).toMatch(/cross-set/);
  });
});
