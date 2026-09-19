import type { ReviewerPort } from "../../domain/ports/reviewer-port.js";
/**
 * `--estimate` support for the claude-cli provider. Unlike Anthropic's
 * `countTokens` (a free, no-model-call endpoint — see estimate-cost.ts),
 * `claude -p` has no equivalent: the only way to learn its token/cost
 * footprint is to actually run it. So this makes `sampleSize` REAL calls
 * (spending nominal subscription quota) and extrapolates the average
 * nominal cost and wall time over `targetHunks`.
 */
import type { HunkRecord } from "../spike/hunk-record.js";

export interface EstimateClaudeCliCostOptions {
  readonly reviewer: ReviewerPort;
  /** Hunks to pick the sample from; the caller decides selection (e.g. already stratified). */
  readonly hunks: readonly HunkRecord[];
  readonly sampleSize: number;
  readonly targetHunks: number;
  readonly seed: number;
}

export interface ClaudeCliCostEstimate {
  readonly sampleSize: number;
  readonly targetHunks: number;
  readonly avgNominalCostUsd: number;
  readonly avgWallMs: number;
  readonly estimatedTotalUsd: number;
  /** Naive serial projection (avgWallMs * targetHunks); a concurrent run will be faster. */
  readonly estimatedWallMsSerial: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function estimateClaudeCliCostUsd(
  options: EstimateClaudeCliCostOptions,
): Promise<ClaudeCliCostEstimate> {
  const sample = options.hunks.slice(0, options.sampleSize);

  const costs: number[] = [];
  const wallTimes: number[] = [];

  for (const hunk of sample) {
    const start = Date.now();
    const output = await options.reviewer.review({
      hunkId: hunk.id,
      file: hunk.file,
      language: hunk.language,
      hunkHeader: hunk.hunkHeader,
      before: hunk.before,
      diff: hunk.diff,
    });
    wallTimes.push(Date.now() - start);
    costs.push(output.nominalCostUsd ?? 0);
  }

  const avgNominalCostUsd = mean(costs);
  const avgWallMs = mean(wallTimes);

  return {
    sampleSize: sample.length,
    targetHunks: options.targetHunks,
    avgNominalCostUsd,
    avgWallMs,
    estimatedTotalUsd: avgNominalCostUsd * options.targetHunks,
    estimatedWallMsSerial: avgWallMs * options.targetHunks,
  };
}
