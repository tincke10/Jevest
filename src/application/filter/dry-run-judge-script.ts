/**
 * Deterministic pseudo-random judge answers for `scripts/filter/run.ts
 * --judge dry-run`, the judge-side twin of ./dry-run-filter-script.ts:
 * proves the H6 path (judge runner, baseline, cost ratio, verdict) end to
 * end without a `claude -p` call. Results are meaningless.
 */
import type { FakeFindingJudgeScript } from "../../adapters/judges/fake-finding-judge.js";
import type { FindingSeverity } from "../../domain/finding.js";
import { hashString, mulberry32 } from "../spike/prng.js";

const SEVERITIES: readonly FindingSeverity[] = ["nit", "minor", "major", "critical"];

export function generateDryRunJudgeScript(seed = 0): FakeFindingJudgeScript {
  return (input) => {
    const rng = mulberry32((seed ^ hashString(input.findingId)) >>> 0);
    const severity = SEVERITIES[Math.floor(rng() * SEVERITIES.length)] ?? "minor";
    return {
      judgment: {
        isRealDefectProb: rng(),
        severity,
        isStyleOnly: rng() < 0.2,
        actionable: rng() < 0.7,
      },
      model: "dry-run-judge",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      latencyMs: Math.round(500 + rng() * 1500),
      nominalCostUsd: 0,
    };
  };
}
