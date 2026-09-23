/**
 * Turns raw coherence spike results into the H7 evaluation report (SPEC
 * §4.2, §5 Fase 0c), one section per variant (with-summary /
 * without-summary), judged separately as the SPEC demands.
 *
 * Primary metric: the positive class is "incoherent" and the score is
 * 1 − P(matches_intent), so recall means "share of crossed descriptions Jev
 * flagged" and precision means "share of flags that were real". Both are
 * swept over thresholds (best F1) and pinned at 0.5, since a production
 * gate would use a fixed threshold. ECE and the confidence summary are
 * computed on the same score. Nouls have no native confidence (SPEC §1.1),
 * so the confidence here is the DERIVED |2p − 1| from coherence-runner.ts
 * and the Markdown says so.
 *
 * Secondary answers (user_facing, breaking, needs_product_owner,
 * risk_level) have no ground truth in this dataset: only counts and mean
 * confidence are reported, never a verdict.
 *
 * Error analysis lists the worst pairs (incoherent with the highest
 * P(matches_intent), coherent with the lowest) and flags the basename leaks
 * documented in datasets/README.md §4, so a reader can tell "Jev was fooled
 * by a shared file name" from "Jev did not read the change".
 */
import {
  type ConfidenceSummary,
  type ThresholdMetrics,
  expectedCalibrationError,
  percentile,
  summarizeConfidence,
  thresholdSweep,
} from "../../domain/metrics.js";
import { areaOf } from "./change-facts.js";
import type {
  CoherencePairResult,
  CoherenceRunResult,
  CoherenceVariant,
} from "./coherence-runner.js";
import type { CoherenceLabel, PrRecord } from "./pr-record.js";
import { RISK_LEVELS } from "./question-set.js";

const DEFAULT_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) =>
  Number(((i + 1) * 0.05).toFixed(2)),
);
const FIXED_THRESHOLD = 0.5;
const WORST_PAIRS_COUNT = 10;
const DEFAULT_DATASET_VERSION = 1;

/**
 * SPEC §4.2 H7: PASS needs recall ≥ 0.90 AND precision ≥ 0.85 at the best
 * threshold, ECE < 0.1 and median confidence ≥ 0.5. Recall < 0.75 is FAIL;
 * anything in between is PARTIAL.
 */
export interface H7Criteria {
  readonly minRecall: number;
  readonly minPrecision: number;
  readonly maxEce: number;
  readonly minMedianConfidence: number;
  readonly failRecall: number;
}

export const DEFAULT_H7_CRITERIA: H7Criteria = {
  minRecall: 0.9,
  minPrecision: 0.85,
  maxEce: 0.1,
  minMedianConfidence: 0.5,
  failRecall: 0.75,
};

/**
 * The six incoherent pairs whose foreign description mentions a basename of
 * the change verbatim (datasets/README.md §4 "Basename leak"), as
 * `${prId}|${descriptionPrId}`.
 */
export const DEFAULT_LEAK_PAIR_IDS: readonly string[] = [
  "colinhacks/zod#6600|colinhacks/zod#6534",
  "colinhacks/zod#6587|colinhacks/zod#6570",
  "honojs/hono#5377|honojs/hono#5266",
  "honojs/hono#5256|honojs/hono#5297",
  "honojs/hono#5272|honojs/hono#5291",
  "trpc/trpc#7191|trpc/trpc#7286",
];

export type H7Verdict = "PASS" | "PARTIAL" | "FAIL";

export interface H7VerdictResult {
  readonly verdict: H7Verdict;
  readonly reasons: string[];
}

export interface MatchesIntentReport {
  readonly sweep: ThresholdMetrics[];
  readonly bestThreshold: number;
  readonly bestMetrics: ThresholdMetrics;
  readonly fixedThreshold: number;
  readonly fixedMetrics: ThresholdMetrics;
  readonly ece: number;
  /** Derived |2p − 1| over all pairs; null when there are no results. */
  readonly confidence: ConfidenceSummary | null;
}

export interface NoulDistribution {
  /** probability >= 0.5 */
  readonly yesCount: number;
  readonly noCount: number;
  readonly meanProbability: number;
  readonly meanConfidence: number;
}

export interface ChoiceDistribution {
  readonly counts: Record<string, number>;
  readonly meanConfidence: number;
}

export interface SecondaryAnswersReport {
  readonly userFacing: NoulDistribution;
  readonly breaking: NoulDistribution;
  readonly needsProductOwner: NoulDistribution;
  readonly riskLevel: ChoiceDistribution;
}

export interface WorstPair {
  readonly pairId: string;
  readonly prId: string;
  readonly descriptionPrId: string;
  readonly label: CoherenceLabel;
  readonly descriptionTitle: string;
  readonly changeAreas: readonly string[];
  /** P(matches_intent) */
  readonly probability: number;
  readonly confidence: number;
  readonly basenameLeak: boolean;
}

export interface VariantTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly wallTimeMs: number;
}

export interface VariantCoherenceReport {
  readonly variant: CoherenceVariant;
  readonly sampleCount: number;
  readonly coherentCount: number;
  readonly incoherentCount: number;
  readonly failureCount: number;
  readonly matchesIntent: MatchesIntentReport;
  readonly secondary: SecondaryAnswersReport;
  readonly worstPairs: WorstPair[];
  readonly totals: VariantTotals;
  readonly h7: H7VerdictResult;
}

/** Totals of the summary pass (pnpm coherence:summarize), when the with-summary variant ran. */
export interface SummarizerPassSummary {
  readonly prCount: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly nominalCostUsd: number;
  /** Sum of per-PR latencies: the meaningful time figure even when the pass is replayed from fixtures. */
  readonly totalLatencyMs: number;
}

/** Which coherence-pairs file fed the run and what crossing strategy it carries (see run.ts `describePairsStrategy`). */
export interface PairsSource {
  readonly path: string;
  readonly strategy: string;
}

export interface CoherenceSpikeReport {
  readonly generatedAt: string;
  readonly datasetVersion: number;
  readonly summarizer: SummarizerPassSummary | null;
  readonly pairsSource: PairsSource | null;
  readonly variants: VariantCoherenceReport[];
}

export interface BuildCoherenceReportOptions {
  readonly thresholds?: readonly number[];
  readonly h7Criteria?: H7Criteria;
  /** Pair ids (`${prId}|${descriptionPrId}`) known to leak a basename. Default {@link DEFAULT_LEAK_PAIR_IDS}. */
  readonly leakPairIds?: readonly string[];
  readonly summarizer?: SummarizerPassSummary;
  readonly now?: () => Date;
  readonly datasetVersion?: number;
  readonly pairsSource?: PairsSource;
}

function incoherentScore(result: CoherencePairResult): number {
  return 1 - result.matchesIntent.probability;
}

function isIncoherent(result: CoherencePairResult): boolean {
  return result.label === "incoherent";
}

function pickBest(sweep: readonly ThresholdMetrics[]): ThresholdMetrics {
  let best: ThresholdMetrics = sweep[0] ?? {
    threshold: FIXED_THRESHOLD,
    matrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
    precision: 0,
    recall: 0,
    f1: 0,
  };
  for (const candidate of sweep) {
    if (candidate.f1 > best.f1) best = candidate;
  }
  return best;
}

function buildMatchesIntentReport(
  results: readonly CoherencePairResult[],
  thresholds: readonly number[],
): MatchesIntentReport {
  const scored = results.map((r) => ({ score: incoherentScore(r), actual: isIncoherent(r) }));
  const sweep = thresholdSweep(scored, thresholds);
  const best = pickBest(sweep);
  const fixed = thresholdSweep(scored, [FIXED_THRESHOLD])[0] as ThresholdMetrics;
  const ece = expectedCalibrationError(
    results.map((r) => ({ prob: incoherentScore(r), actual: isIncoherent(r) })),
  );
  return {
    sweep,
    bestThreshold: best.threshold,
    bestMetrics: best,
    fixedThreshold: FIXED_THRESHOLD,
    fixedMetrics: fixed,
    ece,
    confidence: summarizeConfidence(results.map((r) => r.matchesIntent.confidence)),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function noulDistribution(
  answers: readonly { probability: number; confidence: number }[],
): NoulDistribution {
  const yesCount = answers.filter((a) => a.probability >= 0.5).length;
  return {
    yesCount,
    noCount: answers.length - yesCount,
    meanProbability: mean(answers.map((a) => a.probability)),
    meanConfidence: mean(answers.map((a) => a.confidence)),
  };
}

function buildSecondary(results: readonly CoherencePairResult[]): SecondaryAnswersReport {
  const counts: Record<string, number> = {};
  for (const level of RISK_LEVELS) counts[level] = 0;
  for (const r of results) {
    counts[r.riskLevel.choice] = (counts[r.riskLevel.choice] ?? 0) + 1;
  }
  return {
    userFacing: noulDistribution(results.map((r) => r.userFacing)),
    breaking: noulDistribution(results.map((r) => r.breaking)),
    needsProductOwner: noulDistribution(results.map((r) => r.needsProductOwner)),
    riskLevel: { counts, meanConfidence: mean(results.map((r) => r.riskLevel.confidence)) },
  };
}

/** How wrong the answer is for this pair's label: P for incoherent, 1 − P for coherent. */
function wrongness(result: CoherencePairResult): number {
  return isIncoherent(result)
    ? result.matchesIntent.probability
    : 1 - result.matchesIntent.probability;
}

function buildWorstPairs(
  results: readonly CoherencePairResult[],
  recordsById: ReadonlyMap<string, PrRecord>,
  leakPairIds: ReadonlySet<string>,
): WorstPair[] {
  return [...results]
    .sort((a, b) => wrongness(b) - wrongness(a))
    .slice(0, WORST_PAIRS_COUNT)
    .map((r) => {
      const changePr = recordsById.get(r.prId);
      const descriptionPr = recordsById.get(r.descriptionPrId);
      const changeAreas = changePr ? [...new Set(changePr.files.map((f) => areaOf(f.path)))] : [];
      return {
        pairId: r.pairId,
        prId: r.prId,
        descriptionPrId: r.descriptionPrId,
        label: r.label,
        descriptionTitle: descriptionPr?.title ?? "<unknown PR>",
        changeAreas,
        probability: r.matchesIntent.probability,
        confidence: r.matchesIntent.confidence,
        basenameLeak: leakPairIds.has(r.pairId),
      };
    });
}

function buildTotals(run: CoherenceRunResult): VariantTotals {
  const latencies = run.results.map((r) => r.latencyMs);
  return {
    requests: run.totals.requests,
    inputTokens: run.totals.inputTokens,
    outputTokens: run.totals.outputTokens,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    wallTimeMs: run.totals.wallTimeMs,
  };
}

export function h7Verdict(
  matchesIntent: MatchesIntentReport,
  criteria: H7Criteria = DEFAULT_H7_CRITERIA,
): H7VerdictResult {
  const { recall, precision } = matchesIntent.bestMetrics;
  const medianConfidence = matchesIntent.confidence?.p50 ?? 0;
  const reasons: string[] = [];

  if (recall < criteria.minRecall) {
    reasons.push(
      `recall ${recall.toFixed(3)} at the best threshold is below the required ${criteria.minRecall}`,
    );
  }
  if (precision < criteria.minPrecision) {
    reasons.push(
      `precision ${precision.toFixed(3)} at the best threshold is below the required ${criteria.minPrecision}`,
    );
  }
  if (matchesIntent.ece >= criteria.maxEce) {
    reasons.push(
      `ECE ${matchesIntent.ece.toFixed(3)} is not below the required ${criteria.maxEce}`,
    );
  }
  if (medianConfidence < criteria.minMedianConfidence) {
    reasons.push(
      `median confidence ${medianConfidence.toFixed(3)} is below the required ${criteria.minMedianConfidence}`,
    );
  }

  if (recall < criteria.failRecall) {
    return { verdict: "FAIL", reasons };
  }
  return { verdict: reasons.length === 0 ? "PASS" : "PARTIAL", reasons };
}

function buildVariantReport(
  run: CoherenceRunResult,
  recordsById: ReadonlyMap<string, PrRecord>,
  thresholds: readonly number[],
  criteria: H7Criteria,
  leakPairIds: ReadonlySet<string>,
): VariantCoherenceReport {
  const matchesIntent = buildMatchesIntentReport(run.results, thresholds);
  return {
    variant: run.variant,
    sampleCount: run.results.length,
    coherentCount: run.results.filter((r) => !isIncoherent(r)).length,
    incoherentCount: run.results.filter(isIncoherent).length,
    failureCount: run.failures.length,
    matchesIntent,
    secondary: buildSecondary(run.results),
    worstPairs: buildWorstPairs(run.results, recordsById, leakPairIds),
    totals: buildTotals(run),
    h7: h7Verdict(matchesIntent, criteria),
  };
}

export function buildCoherenceReport(
  runs: readonly CoherenceRunResult[],
  records: readonly PrRecord[],
  options: BuildCoherenceReportOptions = {},
): CoherenceSpikeReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const criteria = options.h7Criteria ?? DEFAULT_H7_CRITERIA;
  const leakPairIds = new Set(options.leakPairIds ?? DEFAULT_LEAK_PAIR_IDS);
  const now = options.now ?? (() => new Date());
  const recordsById = new Map(records.map((r) => [r.id, r]));

  return {
    generatedAt: now().toISOString(),
    datasetVersion: options.datasetVersion ?? records[0]?.datasetVersion ?? DEFAULT_DATASET_VERSION,
    summarizer: options.summarizer ?? null,
    pairsSource: options.pairsSource ?? null,
    variants: runs.map((run) =>
      buildVariantReport(run, recordsById, thresholds, criteria, leakPairIds),
    ),
  };
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function renderMetricsRow(variant: string, kind: string, m: ThresholdMetrics): string {
  return (
    `| ${variant} | ${kind} | ${m.threshold.toFixed(2)} | ${fmt(m.recall)} | ${fmt(m.precision)} | ${fmt(m.f1)} | ` +
    `${m.matrix.tp} | ${m.matrix.fp} | ${m.matrix.fn} | ${m.matrix.tn} |`
  );
}

function renderNoulRow(variant: string, name: string, d: NoulDistribution): string {
  return `| ${variant} | ${name} | ${d.yesCount} | ${d.noCount} | ${fmt(d.meanProbability)} | ${fmt(d.meanConfidence)} |`;
}

export function renderCoherenceReportMarkdown(report: CoherenceSpikeReport): string {
  const lines: string[] = [];
  lines.push("# Jevest phase 0c intent–change coherence report (H7)");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Dataset version: ${report.datasetVersion}`);
  if (report.pairsSource) {
    lines.push(
      `Pairs file: \`${report.pairsSource.path}\` (strategy: ${report.pairsSource.strategy})`,
    );
  }
  lines.push("");
  lines.push(
    "H7 does not block any phase (SPEC §4.2): it decides whether triage (stage 1) receives a " +
      "product state instead of flat metadata. Each variant is judged on its own; if " +
      "without-summary already passes, the LLM summary is not adopted.",
  );
  lines.push("");
  lines.push(
    "Positive class is **incoherent**; score = 1 − P(matches_intent). Nouls carry no native " +
      "confidence (SPEC §1.1), so *confidence* below is the derived |2p − 1|.",
  );
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  lines.push("| Variant | Pairs | Coherent | Incoherent | Failed | H7 |");
  lines.push("|---|---|---|---|---|---|");
  for (const v of report.variants) {
    lines.push(
      `| ${v.variant} | ${v.sampleCount} | ${v.coherentCount} | ${v.incoherentCount} | ${v.failureCount} | **${v.h7.verdict}** |`,
    );
  }
  lines.push("");
  for (const v of report.variants) {
    if (v.h7.reasons.length > 0) {
      lines.push(`- **${v.variant}** ${v.h7.verdict}: ${v.h7.reasons.join("; ")}`);
    }
  }
  lines.push("");

  lines.push("## matches_intent");
  lines.push("");
  lines.push("| Variant | Threshold | Value | Recall | Precision | F1 | TP | FP | FN | TN |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const v of report.variants) {
    lines.push(renderMetricsRow(v.variant, "best F1", v.matchesIntent.bestMetrics));
    lines.push(renderMetricsRow(v.variant, "fixed", v.matchesIntent.fixedMetrics));
  }
  lines.push("");
  lines.push("| Variant | ECE | Confidence p10 | p50 | p90 | mean |");
  lines.push("|---|---|---|---|---|---|");
  for (const v of report.variants) {
    const c = v.matchesIntent.confidence;
    lines.push(
      `| ${v.variant} | ${fmt(v.matchesIntent.ece)} | ${fmt(c?.p10 ?? 0)} | ${fmt(c?.p50 ?? 0)} | ${fmt(c?.p90 ?? 0)} | ${fmt(c?.mean ?? 0)} |`,
    );
  }
  lines.push("");
  lines.push("### Threshold sweep");
  lines.push("");
  for (const v of report.variants) {
    lines.push(`**${v.variant}**`);
    lines.push("");
    lines.push("| Threshold | Recall | Precision | F1 |");
    lines.push("|---|---|---|---|");
    for (const m of v.matchesIntent.sweep) {
      lines.push(
        `| ${m.threshold.toFixed(2)} | ${fmt(m.recall)} | ${fmt(m.precision)} | ${fmt(m.f1)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Secondary answers");
  lines.push("");
  lines.push("No ground truth in this dataset: counts and mean confidence only, no verdict.");
  lines.push("");
  lines.push("| Variant | Question | Yes (p ≥ 0.5) | No | Mean p | Mean confidence |");
  lines.push("|---|---|---|---|---|---|");
  for (const v of report.variants) {
    lines.push(renderNoulRow(v.variant, "user_facing", v.secondary.userFacing));
    lines.push(renderNoulRow(v.variant, "breaking", v.secondary.breaking));
    lines.push(renderNoulRow(v.variant, "needs_product_owner", v.secondary.needsProductOwner));
  }
  lines.push("");
  lines.push(`| Variant | ${RISK_LEVELS.join(" | ")} | Mean confidence |`);
  lines.push(`|---|${RISK_LEVELS.map(() => "---").join("|")}|---|`);
  for (const v of report.variants) {
    const counts = RISK_LEVELS.map((level) => v.secondary.riskLevel.counts[level] ?? 0);
    lines.push(
      `| ${v.variant} | ${counts.join(" | ")} | ${fmt(v.secondary.riskLevel.meanConfidence)} |`,
    );
  }
  lines.push("");

  lines.push("## Error analysis");
  lines.push("");
  lines.push(
    "Worst pairs: incoherent pairs with the highest P(matches_intent) and coherent pairs with the " +
      "lowest. *Leak* marks the basename leaks listed in datasets/README.md §4.",
  );
  lines.push("");
  for (const v of report.variants) {
    lines.push(`**${v.variant}**`);
    lines.push("");
    lines.push(
      "| Change PR | Description PR | Label | Description title | Change areas | P | Confidence | Leak |",
    );
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const w of v.worstPairs) {
      const title = w.descriptionTitle.replace(/\|/g, "\\|");
      lines.push(
        `| ${w.prId} | ${w.descriptionPrId} | ${w.label} | ${title} | ${w.changeAreas.join(", ")} | ` +
          `${fmt(w.probability)} | ${fmt(w.confidence)} | ${w.basenameLeak ? "yes" : ""} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Totals");
  lines.push("");
  lines.push(
    "| Variant | Requests | Input tokens | Output tokens | p50 latency (ms) | p95 latency (ms) | Wall time (s) |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const v of report.variants) {
    lines.push(
      `| ${v.variant} | ${v.totals.requests} | ${v.totals.inputTokens} | ${v.totals.outputTokens} | ` +
        `${v.totals.latencyP50Ms.toFixed(0)} | ${v.totals.latencyP95Ms.toFixed(0)} | ${(v.totals.wallTimeMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push("");
  if (report.summarizer) {
    const s = report.summarizer;
    lines.push(
      `Summary pass (claude-cli, billed to the subscription): ${s.prCount} PR(s) summarized, ` +
        `${s.failures} failure(s), ${s.inputTokens} input / ${s.outputTokens} output tokens, ` +
        `nominal cost ${s.nominalCostUsd.toFixed(6)} USD, summed latency ${(s.totalLatencyMs / 1000).toFixed(1)} s.`,
    );
  } else {
    lines.push("Summary pass: not run (without-summary only).");
  }
  lines.push("");

  return lines.join("\n");
}
