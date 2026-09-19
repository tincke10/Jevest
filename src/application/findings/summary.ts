/**
 * Aggregates `datasets/findings.jsonl` records into the H1/H6/H3 report
 * numbers (SPEC §5 Fase 1a step 5). `totalCostUsd` and `latencyMs` are
 * deduped per hunk id: `cost_usd`/`latency_ms` on a FindingRecord describe
 * the whole reviewer request that produced it, and a hunk with N findings
 * repeats that same value N times — summing the raw rows would overcount.
 * A hunk with zero findings never appears in `records` at all, so its cost
 * isn't reflected here; use GenerateFindingsResult.totalCostUsd for the true
 * run total.
 */
import type { FindingRecord, FindingSeverity } from "../../domain/finding.js";

export interface PercentileStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface FindingsSummary {
  readonly totalFindings: number;
  readonly hunksReviewed: number;
  /** Average findings per hunk actually reviewed, including hunks with zero findings. */
  readonly findingsPerHunk: number;
  readonly countsBySeverity: Record<FindingSeverity, number>;
  readonly realCount: number;
  readonly noiseCount: number;
  /** 0..100. Share of *findings* (not hunks) whose originating hunk was benign. */
  readonly percentFindingsOnBenignHunks: number;
  /** Sum of cost across unique hunks represented in `records` (see module doc). */
  readonly totalCostUsd: number;
  /** Percentiles over unique per-hunk latency (see module doc). */
  readonly latencyMs: PercentileStats;
}

export interface SummarizeFindingsOptions {
  readonly records: readonly FindingRecord[];
  /** Total hunks the reviewer was actually called for, including zero-finding hunks. */
  readonly hunksReviewed: number;
  /** hunk id -> whether that hunk is a genuine defect (SPEC label.defect). */
  readonly defectByHunkId: ReadonlyMap<string, boolean>;
}

const SEVERITIES: readonly FindingSeverity[] = ["nit", "minor", "major", "critical"];

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error(`percentile: index ${index} out of bounds for length ${sorted.length}`);
  }
  return value;
}

export function summarizeFindings(options: SummarizeFindingsOptions): FindingsSummary {
  const { records, hunksReviewed, defectByHunkId } = options;

  const countsBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<
    FindingSeverity,
    number
  >;
  let realCount = 0;
  let noiseCount = 0;
  let benignHunkFindings = 0;

  // First-seen cost/latency per hunk id, to avoid double-counting a per-request
  // value that's repeated across every finding row from the same hunk.
  const perHunk = new Map<string, { costUsd: number; latencyMs: number }>();

  for (const record of records) {
    countsBySeverity[record.suggestedSeverity] += 1;
    if (record.label.real) {
      realCount += 1;
    } else {
      noiseCount += 1;
    }
    if (defectByHunkId.get(record.hunkId) === false) {
      benignHunkFindings += 1;
    }
    if (!perHunk.has(record.hunkId)) {
      perHunk.set(record.hunkId, { costUsd: record.costUsd, latencyMs: record.latencyMs });
    }
  }

  const totalCostUsd = [...perHunk.values()].reduce((sum, h) => sum + h.costUsd, 0);
  const latencies = [...perHunk.values()].map((h) => h.latencyMs).sort((a, b) => a - b);

  const totalFindings = records.length;

  return {
    totalFindings,
    hunksReviewed,
    findingsPerHunk: hunksReviewed === 0 ? 0 : totalFindings / hunksReviewed,
    countsBySeverity,
    realCount,
    noiseCount,
    percentFindingsOnBenignHunks:
      totalFindings === 0 ? 0 : (benignHunkFindings / totalFindings) * 100,
    totalCostUsd,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  };
}
