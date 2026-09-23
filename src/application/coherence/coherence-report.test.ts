import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAK_PAIR_IDS,
  buildCoherenceReport,
  renderCoherenceReportMarkdown,
} from "./coherence-report.js";
import type { CoherencePairResult, CoherenceRunResult } from "./coherence-runner.js";
import type { CoherenceLabel, PrRecord } from "./pr-record.js";

function makeRecord(id: string, title: string, area: string): PrRecord {
  return {
    id,
    repo: "owner/repo",
    number: Number(id.split("#")[1]),
    title,
    body: "body",
    labels: [],
    author: "someone",
    baseSha: "base",
    headSha: "head",
    mergedAt: "2026-01-01T00:00:00Z",
    files: [{ path: `${area}/index.ts`, status: "modified", additions: 1, deletions: 1 }],
    datasetVersion: 1,
  };
}

const RECORDS = [
  makeRecord("owner/repo#1", "Alpha title", "alpha"),
  makeRecord("owner/repo#2", "Beta title", "beta"),
  makeRecord("owner/repo#3", "Gamma title", "gamma"),
  makeRecord("owner/repo#4", "Delta title", "delta"),
];

function result(
  prId: string,
  descriptionPrId: string,
  label: CoherenceLabel,
  matches: number,
  overrides: Partial<CoherencePairResult> = {},
): CoherencePairResult {
  return {
    pairId: `${prId}|${descriptionPrId}`,
    prId,
    descriptionPrId,
    label,
    variant: "without-summary",
    matchesIntent: { probability: matches, confidence: Math.abs(2 * matches - 1) },
    userFacing: { probability: 0.8, confidence: 0.6 },
    breaking: { probability: 0.1, confidence: 0.8 },
    needsProductOwner: { probability: 0.3, confidence: 0.4 },
    riskLevel: {
      choice: "low",
      confidence: 0.7,
      probabilities: { none: 0.1, low: 0.6, medium: 0.2, high: 0.05, critical: 0.05 },
    },
    requestId: `req_${prId}_${descriptionPrId}`,
    latencyMs: 100,
    usage: { inputTokens: 1000, outputTokens: 50 },
    ...overrides,
  };
}

function run(results: CoherencePairResult[], failures = 0): CoherenceRunResult {
  return {
    variant: "without-summary",
    results,
    failures: Array.from({ length: failures }, (_, i) => ({
      pairId: `fail|${i}`,
      pairIndex: i,
      error: "boom",
    })),
    totals: {
      requests: results.length,
      inputTokens: results.length * 1000,
      outputTokens: results.length * 50,
      totalLatencyMs: results.length * 100,
      wallTimeMs: 5000,
    },
  };
}

/**
 * 4 coherent with P(match) ~0.96, 4 incoherent with P(match) ~0.04: a
 * perfect, well-calibrated separator (ECE ~0.035).
 */
const PERFECT = [
  result("owner/repo#1", "owner/repo#1", "coherent", 0.98),
  result("owner/repo#2", "owner/repo#2", "coherent", 0.97),
  result("owner/repo#3", "owner/repo#3", "coherent", 0.96),
  result("owner/repo#4", "owner/repo#4", "coherent", 0.95),
  result("owner/repo#1", "owner/repo#2", "incoherent", 0.02),
  result("owner/repo#2", "owner/repo#3", "incoherent", 0.03),
  result("owner/repo#3", "owner/repo#4", "incoherent", 0.04),
  result("owner/repo#4", "owner/repo#1", "incoherent", 0.05),
];

describe("buildCoherenceReport", () => {
  it("scores the incoherent class with 1 - P(matches_intent) and finds a perfect best threshold", () => {
    const report = buildCoherenceReport([run(PERFECT)], RECORDS, {
      now: () => new Date("2026-09-21T00:00:00Z"),
    });

    expect(report.generatedAt).toBe("2026-09-21T00:00:00.000Z");
    expect(report.variants).toHaveLength(1);
    const v = report.variants[0]!;
    expect(v.variant).toBe("without-summary");
    expect(v.sampleCount).toBe(8);
    expect(v.coherentCount).toBe(4);
    expect(v.incoherentCount).toBe(4);
    expect(v.matchesIntent.bestMetrics.recall).toBe(1);
    expect(v.matchesIntent.bestMetrics.precision).toBe(1);
    expect(v.matchesIntent.bestMetrics.f1).toBe(1);
    expect(v.matchesIntent.bestThreshold).toBeGreaterThan(0.05);
    expect(v.matchesIntent.bestThreshold).toBeLessThanOrEqual(0.95);
    expect(v.matchesIntent.fixedThreshold).toBe(0.5);
    expect(v.matchesIntent.fixedMetrics.recall).toBe(1);
    expect(v.matchesIntent.fixedMetrics.precision).toBe(1);
    expect(v.matchesIntent.ece).toBeLessThan(0.1);
    expect(v.matchesIntent.confidence?.p50).toBeCloseTo(0.93, 5);
  });

  it("defaults pairsSource to null and carries it through when given", () => {
    const withoutSource = buildCoherenceReport([run(PERFECT)], RECORDS);
    expect(withoutSource.pairsSource).toBeNull();

    const withSource = buildCoherenceReport([run(PERFECT)], RECORDS, {
      pairsSource: { path: "datasets/coherence-pairs-hard.jsonl", strategy: "hard" },
    });
    expect(withSource.pairsSource).toEqual({
      path: "datasets/coherence-pairs-hard.jsonl",
      strategy: "hard",
    });
  });

  it("verdict PASS when recall, precision, ECE and median confidence all meet SPEC H7", () => {
    const report = buildCoherenceReport([run(PERFECT)], RECORDS);
    expect(report.variants[0]!.h7).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("verdict FAIL when recall at the best threshold is below 0.75", () => {
    // Two of five incoherent pairs look perfectly coherent (P = 0.98): the
    // best-F1 threshold catches the other three at precision 1 (F1 0.75),
    // which beats "flag everything" (F1 0.667), so recall at best F1 is 0.6.
    const results = [
      result("owner/repo#1", "owner/repo#1", "coherent", 0.9),
      result("owner/repo#2", "owner/repo#2", "coherent", 0.9),
      result("owner/repo#3", "owner/repo#3", "coherent", 0.9),
      result("owner/repo#4", "owner/repo#4", "coherent", 0.9),
      result("owner/repo#1", "owner/repo#2", "incoherent", 0.1),
      result("owner/repo#2", "owner/repo#3", "incoherent", 0.1),
      result("owner/repo#3", "owner/repo#4", "incoherent", 0.1),
      result("owner/repo#4", "owner/repo#1", "incoherent", 0.98),
      result("owner/repo#1", "owner/repo#3", "incoherent", 0.98),
    ];
    const report = buildCoherenceReport([run(results)], RECORDS);
    const h7 = report.variants[0]!.h7;
    expect(h7.verdict).toBe("FAIL");
    expect(h7.reasons.join(" ")).toMatch(/recall/);
  });

  it("verdict PARTIAL naming the failed criterion when recall is fine but confidence is low", () => {
    const soft = PERFECT.map((r) => ({
      ...r,
      matchesIntent: {
        probability: r.label === "coherent" ? 0.6 : 0.4,
        confidence: 0.2,
      },
    }));
    const report = buildCoherenceReport([run(soft)], RECORDS);
    const h7 = report.variants[0]!.h7;
    expect(h7.verdict).toBe("PARTIAL");
    expect(h7.reasons.some((r) => /median confidence/.test(r))).toBe(true);
    expect(h7.reasons.some((r) => /recall/.test(r))).toBe(false);
  });

  it("summarizes secondary answers as counts and mean confidence, with no ground truth", () => {
    const report = buildCoherenceReport([run(PERFECT)], RECORDS);
    const s = report.variants[0]!.secondary;
    expect(s.userFacing.yesCount).toBe(8);
    expect(s.userFacing.noCount).toBe(0);
    expect(s.userFacing.meanProbability).toBeCloseTo(0.8);
    expect(s.userFacing.meanConfidence).toBeCloseTo(0.6);
    expect(s.breaking.yesCount).toBe(0);
    expect(s.riskLevel.counts).toEqual({ none: 0, low: 8, medium: 0, high: 0, critical: 0 });
    expect(s.riskLevel.meanConfidence).toBeCloseTo(0.7);
  });

  it("lists the worst pairs with the description PR title, the change areas and the leak flag", () => {
    const results = [...PERFECT, result("owner/repo#1", "owner/repo#3", "incoherent", 0.99)];
    const report = buildCoherenceReport([run(results)], RECORDS, {
      leakPairIds: ["owner/repo#1|owner/repo#3"],
    });
    const worst = report.variants[0]!.worstPairs;
    expect(worst.length).toBeLessThanOrEqual(10);
    expect(worst[0]).toEqual({
      pairId: "owner/repo#1|owner/repo#3",
      prId: "owner/repo#1",
      descriptionPrId: "owner/repo#3",
      label: "incoherent",
      descriptionTitle: "Gamma title",
      changeAreas: ["alpha"],
      probability: 0.99,
      confidence: expect.closeTo(0.98, 5),
      basenameLeak: true,
    });
    // The lowest-P coherent pair (P = 0.95) is also among the worst.
    expect(worst.some((w) => w.pairId === "owner/repo#4|owner/repo#4")).toBe(true);
    expect(worst.filter((w) => w.basenameLeak)).toHaveLength(1);
  });

  it("ships the README basename-leak pair ids by default", () => {
    expect(DEFAULT_LEAK_PAIR_IDS).toContain("colinhacks/zod#6600|colinhacks/zod#6534");
    expect(DEFAULT_LEAK_PAIR_IDS).toContain("trpc/trpc#7191|trpc/trpc#7286");
    expect(DEFAULT_LEAK_PAIR_IDS).toHaveLength(6);
  });

  it("carries totals, latency percentiles, failures and the summarizer pass when given", () => {
    const report = buildCoherenceReport([run(PERFECT, 2)], RECORDS, {
      summarizer: {
        prCount: 4,
        failures: 0,
        inputTokens: 40000,
        outputTokens: 2000,
        nominalCostUsd: 1.23,
        totalLatencyMs: 60000,
      },
    });
    const v = report.variants[0]!;
    expect(v.failureCount).toBe(2);
    expect(v.totals).toEqual({
      requests: 8,
      inputTokens: 8000,
      outputTokens: 400,
      latencyP50Ms: 100,
      latencyP95Ms: 100,
      wallTimeMs: 5000,
    });
    expect(report.summarizer?.nominalCostUsd).toBe(1.23);
  });

  it("reports one variant per run and a null summarizer when none is given", () => {
    const withSummary: CoherenceRunResult = {
      ...run(PERFECT.map((r) => ({ ...r, variant: "with-summary" as const }))),
      variant: "with-summary",
    };
    const report = buildCoherenceReport([run(PERFECT), withSummary], RECORDS);
    expect(report.variants.map((v) => v.variant)).toEqual(["without-summary", "with-summary"]);
    expect(report.summarizer).toBeNull();
  });
});

describe("renderCoherenceReportMarkdown", () => {
  it("renders every section with the verdict and the derived-confidence note", () => {
    const report = buildCoherenceReport([run(PERFECT)], RECORDS, {
      leakPairIds: [],
      summarizer: {
        prCount: 4,
        failures: 0,
        inputTokens: 1,
        outputTokens: 1,
        nominalCostUsd: 0.5,
        totalLatencyMs: 1000,
      },
    });
    const md = renderCoherenceReportMarkdown(report);

    expect(md).toContain("# Jevest phase 0c intent–change coherence report (H7)");
    expect(md).toContain("## matches_intent");
    expect(md).toContain("PASS");
    expect(md).toContain("|2p − 1|");
    expect(md).toContain("## Secondary answers");
    expect(md).toContain("## Error analysis");
    expect(md).toContain("Gamma title");
    expect(md).toContain("## Totals");
    expect(md).toContain("0.500000");
  });

  it("prints the pairs file and strategy when pairsSource is set, omits the line otherwise", () => {
    const withSource = renderCoherenceReportMarkdown(
      buildCoherenceReport([run(PERFECT)], RECORDS, {
        pairsSource: { path: "datasets/coherence-pairs-hard.jsonl", strategy: "hard" },
      }),
    );
    expect(withSource).toContain(
      "Pairs file: `datasets/coherence-pairs-hard.jsonl` (strategy: hard)",
    );

    const withoutSource = renderCoherenceReportMarkdown(
      buildCoherenceReport([run(PERFECT)], RECORDS),
    );
    expect(withoutSource).not.toContain("Pairs file:");
  });
});
