/**
 * Fix-aware ORACLE labeling of review findings (datasets/FINDINGS.md §10):
 * the pure combination rule plus the runner that drives
 * `src/domain/ports/finding-labeler-port.ts` over a findings dataset.
 *
 * Why this exists: the line-overlap label (FINDINGS.md §2) does not measure
 * "is this finding a real defect" — Jev (AUC 0.592) and a DeepSeek reasoning
 * judge (AUC 0.567) are both at chance against it, and the judge was seeing
 * exactly what Jev sees. The oracle labeler sees strictly more: the code AFTER
 * the fix, the fix's commit message and the linked issue. That is the future
 * of the hunk, which no scored side ever had, so it is a genuinely new signal
 * rather than the same model grading its own homework.
 *
 * Two passes, two framings, one model, agreement required. Mirrors
 * ../filter/judge-runner.ts's worker pool and rate-limit retry: a finding
 * whose call throws is recorded as a failure and the run continues;
 * persistent rate limiting stops the run.
 */
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import { percentile } from "../../domain/metrics.js";
import type {
  ClaimVerificationVerdict,
  FindingLabelerInput,
  FindingLabelerPort,
  FixMatchVerdict,
} from "../../domain/ports/finding-labeler-port.js";
import type { FindingRecord } from "../filter/finding-record.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import type { RetryOptions } from "./generate-findings.js";
import type { HunkEvidenceRecord } from "./hunk-evidence.js";
import { type ModelPricing, pricingForModel, reviewCostUsd } from "./pricing.js";

/** The three-way oracle verdict. `unknown` is excluded from H1 scoring, never counted as noise. */
export type OracleVerdict = "real" | "noise" | "unknown";

export interface CombineOracleOptions {
  /**
   * `hunks.jsonl`'s own defect label. Default true. On a benign hunk there is
   * no fixed defect for a finding to match, so a "real" fix-match verdict
   * there is a labeler mistake and is downgraded to `unknown` rather than
   * trusted. "noise" is still reachable on a benign hunk — that is exactly
   * where the absence judgment carries the label.
   */
  readonly hunkIsDefect?: boolean;
}

/**
 * The combination rule. Only a two-way agreement is decisive:
 *
 * - fix-match "real" AND claim-verification "present" -> `real`: the finding
 *   names the defect the fix addressed, and the claim is true of the before
 *   code. Both readings had to land.
 * - fix-match "not-this" AND claim-verification "absent" -> `noise`: the fix
 *   was about something else AND the claimed problem is not in the code.
 * - everything else -> `unknown`.
 *
 * The important asymmetric case is "not-this" + "present": a claim that is
 * TRUE about the code but describes something the fix did not touch. That is
 * a plausible real issue the oracle cannot confirm, so it is `unknown`, never
 * `noise`. Scoring it as noise would punish a filter for keeping a correct
 * finding, which is the exact error the line-overlap label already makes.
 */
export function combineOracleVerdicts(
  fixMatch: FixMatchVerdict,
  claimVerification: ClaimVerificationVerdict,
  options: CombineOracleOptions = {},
): OracleVerdict {
  const hunkIsDefect = options.hunkIsDefect ?? true;
  if (fixMatch === "real" && claimVerification === "present") {
    return hunkIsDefect ? "real" : "unknown";
  }
  if (fixMatch === "not-this" && claimVerification === "absent") {
    return "noise";
  }
  return "unknown";
}

/** One pass's answer as persisted next to the verdict, for audit. */
export interface OraclePassRecord<V extends string> {
  readonly verdict: V;
  readonly confidence: number;
  readonly reason: string;
}

export interface OracleLabelResult {
  readonly findingId: string;
  readonly verdict: OracleVerdict;
  readonly labelerModel: string;
  readonly fixMatch: OraclePassRecord<FixMatchVerdict>;
  readonly claimVerification: OraclePassRecord<ClaimVerificationVerdict>;
  /** Cost of BOTH calls for this finding. */
  readonly costUsd: number;
  /** Sum of both calls' latency. */
  readonly latencyMs: number;
}

export interface OracleLabelFailure {
  readonly findingId: string;
  readonly error: string;
}

export interface OracleRunTotals {
  /** Labeler calls that returned, i.e. 2 per successfully labeled finding. */
  readonly requests: number;
  readonly totalCostUsd: number;
  readonly wallTimeMs: number;
}

export interface OracleRunResult {
  readonly results: OracleLabelResult[];
  readonly failures: OracleLabelFailure[];
  readonly totals: OracleRunTotals;
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

export interface RunOracleLabelerOptions {
  readonly labeler: FindingLabelerPort;
  readonly findings: readonly FindingRecord[];
  readonly hunksById: ReadonlyMap<string, HunkRecord>;
  /** Issue / PR text per hunk, from datasets/hunk-evidence.jsonl. Optional. */
  readonly evidenceByHunkId?: ReadonlyMap<string, HunkEvidenceRecord>;
  /** Findings labeled in parallel (each costs 2 sequential calls). Default 1. */
  readonly concurrency?: number;
  readonly retry?: RetryOptions;
  /** Used only when the labeler reports no nominal cost. Default: `pricingForModel(output.model)`. */
  readonly pricing?: ModelPricing;
  readonly onProgress?: (info: { completed: number; total: number }) => void;
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds what the labeler is shown. The existing label never enters this object. */
export function buildLabelerInput(
  finding: FindingRecord,
  hunk: HunkRecord,
  evidence?: HunkEvidenceRecord,
): FindingLabelerInput {
  return {
    findingId: finding.id,
    claim: finding.claim,
    rationale: finding.rationale,
    file: finding.file,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    hunkHeader: hunk.hunkHeader,
    language: hunk.language,
    before: hunk.before,
    after: hunk.after,
    commitMessage: hunk.evidence.commitMessage,
    hunkIsDefect: hunk.label.defect,
    ...(evidence?.issueTitle !== undefined ? { issueTitle: evidence.issueTitle } : {}),
    ...(evidence?.issueBody !== undefined ? { issueBody: evidence.issueBody } : {}),
    ...(evidence?.prTitle !== undefined ? { prTitle: evidence.prTitle } : {}),
    ...(evidence?.prBody !== undefined ? { prBody: evidence.prBody } : {}),
  };
}

export async function runOracleLabeler(options: RunOracleLabelerOptions): Promise<OracleRunResult> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  const backoffMs = options.retry?.backoffMs ?? 0;
  const sleep = options.retry?.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const wallStart = now();

  // Fail before any call if a finding has no hunk: same rule as the judge runner.
  const items = options.findings.map((finding) => {
    const hunk = options.hunksById.get(finding.hunkId);
    if (hunk === undefined) {
      throw new Error(`no hunk found for finding "${finding.id}" (hunk_id "${finding.hunkId}")`);
    }
    return {
      finding,
      hunk,
      input: buildLabelerInput(finding, hunk, options.evidenceByHunkId?.get(finding.hunkId)),
    };
  });

  const results: OracleLabelResult[] = [];
  const failures: OracleLabelFailure[] = [];
  let totalCostUsd = 0;
  let requests = 0;
  let completed = 0;
  let stopped = false;
  let stopReason: string | undefined;
  let nextIndex = 0;

  async function withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await call();
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
      if (stopped || nextIndex >= items.length) {
        return;
      }
      const item = items[nextIndex];
      nextIndex += 1;
      if (item === undefined) {
        return;
      }

      try {
        // Sequential on purpose: the two passes share a system prompt cache
        // per framing, and firing both at once doubles the burst rate for no
        // wall-clock gain at the concurrency levels this runs at.
        const fixMatch = await withRetry(() => options.labeler.labelFixMatch(item.input));
        const claim = await withRetry(() => options.labeler.labelClaimVerification(item.input));
        requests += 2;

        const costUsd = [fixMatch, claim].reduce(
          (sum, output) =>
            sum +
            (output.nominalCostUsd ??
              reviewCostUsd(output.usage, options.pricing ?? pricingForModel(output.model))),
          0,
        );
        totalCostUsd += costUsd;

        results.push({
          findingId: item.finding.id,
          verdict: combineOracleVerdicts(fixMatch.verdict, claim.verdict, {
            hunkIsDefect: item.hunk.label.defect,
          }),
          labelerModel: fixMatch.model,
          fixMatch: {
            verdict: fixMatch.verdict,
            confidence: fixMatch.confidence,
            reason: fixMatch.reason,
          },
          claimVerification: {
            verdict: claim.verdict,
            confidence: claim.confidence,
            reason: claim.reason,
          },
          costUsd,
          latencyMs: fixMatch.latencyMs + claim.latencyMs,
        });
      } catch (error) {
        if (error instanceof ReviewerRateLimitError) {
          stopped = true;
          stopReason = `stopped after exhausting retries on a rate limit / usage limit for finding "${item.finding.id}"`;
        }
        failures.push({
          findingId: item.finding.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      completed += 1;
      options.onProgress?.({ completed, total: items.length });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    results,
    failures,
    totals: { requests, totalCostUsd, wallTimeMs: now() - wallStart },
    stoppedEarly: stopped,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

export interface OracleRunSummary {
  readonly counts: { readonly real: number; readonly noise: number; readonly unknown: number };
  /** Findings that got an oracle label at all (failures excluded). */
  readonly labeled: number;
  readonly failures: number;
  /**
   * Share of labeled findings where the two framings agreed decisively
   * (real or noise). A low rate is not a bug: it says the two readings of the
   * same evidence disagree often, which is exactly what `unknown` is for.
   */
  readonly agreementRate: number;
  readonly unknownShare: number;
  readonly totalCostUsd: number;
  readonly wallTimeMs: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly labelerModel: string;
}

export function summarizeOracleRun(run: OracleRunResult): OracleRunSummary {
  const counts = { real: 0, noise: 0, unknown: 0 };
  const latencies: number[] = [];
  let labelerModel = "";
  for (const result of run.results) {
    counts[result.verdict] += 1;
    latencies.push(result.latencyMs);
    labelerModel = labelerModel || result.labelerModel;
  }
  const labeled = run.results.length;
  const decisive = counts.real + counts.noise;
  return {
    counts,
    labeled,
    failures: run.failures.length,
    agreementRate: labeled === 0 ? 0 : decisive / labeled,
    unknownShare: labeled === 0 ? 0 : counts.unknown / labeled,
    totalCostUsd: run.totals.totalCostUsd,
    wallTimeMs: run.totals.wallTimeMs,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    labelerModel,
  };
}
