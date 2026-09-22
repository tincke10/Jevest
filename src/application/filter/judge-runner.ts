/**
 * Runs the LLM-judge baseline (H6, SPEC FR-8.3, §5 Fase 1a step 4) over
 * the same findings the Jev filter sees, one judge call per finding, so
 * the report can compare recall, noise discarded, cost and latency on the
 * same set. Mirrors ../findings/generate-findings.ts's worker pool and
 * rate-limit retry: a finding whose call throws is recorded as a failure
 * and the run continues; persistent rate limiting stops the run.
 *
 * The judge input is built from exactly the Jev state for the finding
 * (finding-questions.ts `buildFindingState`): hunk diff, claim, rationale,
 * file, lines. No label ever reaches the judge.
 */
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import type { FindingBilling, FindingSeverity } from "../../domain/finding.js";
import type {
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";
import type { ReviewUsage } from "../../domain/ports/reviewer-port.js";
import type { RetryOptions } from "../findings/generate-findings.js";
import { type ModelPricing, pricingForModel, reviewCostUsd } from "../findings/pricing.js";
import type { FindingRecord } from "./finding-record.js";

export interface JudgeResult {
  readonly findingId: string;
  readonly isRealDefectProb: number;
  readonly severity: FindingSeverity;
  readonly isStyleOnly: boolean;
  readonly actionable: boolean;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: ReviewUsage;
  /** Nominal (subscription) or real (api) cost of this one judge call; see `billing`. */
  readonly costUsd: number;
  readonly billing: FindingBilling;
}

export interface JudgeFailure {
  readonly findingId: string;
  readonly error: string;
}

export interface JudgeRunTotals {
  readonly requests: number;
  readonly totalCostUsd: number;
  readonly wallTimeMs: number;
}

export interface JudgeRunResult {
  readonly results: JudgeResult[];
  readonly failures: JudgeFailure[];
  readonly totals: JudgeRunTotals;
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

export interface RunJudgeOptions {
  readonly judge: FindingJudgePort;
  readonly findings: readonly FindingRecord[];
  readonly hunkDiffsById: ReadonlyMap<string, string>;
  /** Findings judged in parallel. Default 1. */
  readonly concurrency?: number;
  readonly retry?: RetryOptions;
  /** Used only when the judge reports no nominal cost. Default: `pricingForModel(output.model)`. */
  readonly pricing?: ModelPricing;
  readonly onProgress?: (info: { completed: number; total: number }) => void;
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runJudge(options: RunJudgeOptions): Promise<JudgeRunResult> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  const backoffMs = options.retry?.backoffMs ?? 0;
  const sleep = options.retry?.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const wallStart = now();

  // Fail before any call if a finding has no hunk: same rule as buildFindingFanOut.
  const inputs = options.findings.map((finding) => {
    const hunkDiff = options.hunkDiffsById.get(finding.hunkId);
    if (hunkDiff === undefined) {
      throw new Error(`no hunk found for finding "${finding.id}" (hunk_id "${finding.hunkId}")`);
    }
    return {
      findingId: finding.id,
      hunkDiff,
      file: finding.file,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      claim: finding.claim,
      rationale: finding.rationale,
    };
  });

  const results: JudgeResult[] = [];
  const failures: JudgeFailure[] = [];
  let totalCostUsd = 0;
  let completed = 0;
  let stopped = false;
  let stopReason: string | undefined;
  let nextIndex = 0;

  async function judgeWithRetry(input: (typeof inputs)[number]): Promise<FindingJudgeOutput> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await options.judge.judge(input);
      } catch (error) {
        if (!(error instanceof ReviewerRateLimitError) || attempt === maxAttempts) {
          throw error;
        }
        await sleep(backoffMs);
      }
    }
    throw new Error("unreachable");
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped || nextIndex >= inputs.length) {
        return;
      }
      const input = inputs[nextIndex];
      nextIndex += 1;
      if (input === undefined) {
        return;
      }

      try {
        const output = await judgeWithRetry(input);
        const costUsd =
          output.nominalCostUsd ??
          reviewCostUsd(output.usage, options.pricing ?? pricingForModel(output.model));
        totalCostUsd += costUsd;
        results.push({
          findingId: input.findingId,
          isRealDefectProb: output.judgment.isRealDefectProb,
          severity: output.judgment.severity,
          isStyleOnly: output.judgment.isStyleOnly,
          actionable: output.judgment.actionable,
          model: output.model,
          latencyMs: output.latencyMs,
          usage: output.usage,
          costUsd,
          billing: output.nominalCostUsd !== undefined ? "subscription" : "api",
        });
      } catch (error) {
        if (error instanceof ReviewerRateLimitError) {
          stopped = true;
          stopReason = `stopped after exhausting retries on a rate limit / usage limit for finding "${input.findingId}"`;
        }
        failures.push({
          findingId: input.findingId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      completed += 1;
      options.onProgress?.({ completed, total: inputs.length });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    results,
    failures,
    totals: { requests: results.length, totalCostUsd, wallTimeMs: now() - wallStart },
    stoppedEarly: stopped,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
