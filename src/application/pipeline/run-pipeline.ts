import type { JevestConfig } from "../../adapters/config/jevest-config.js";
/**
 * Orchestrates the six-stage pipeline (SPEC §3, §4.2/§4.3, FR-2..FR-7) over
 * ports, runnable locally. NFR-2 fail-closed: if Jev fails to respond
 * during triage or hunk-profile, the run stops there and publishes a
 * failure — continuing to call an already-broken Jev at every remaining
 * stage would only burn budget without adding evidence. Individual
 * finding-filter classification failures are NOT fatal (filter-runner.ts
 * already routes them to `needsHuman` as "unverified" — see
 * finding-filter.ts), so the pipeline continues past those. FR-2.3: when
 * triage decides the LLM review is unnecessary, every later stage is
 * skipped and only the triage label/summary is published.
 */
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { SpendLedgerPort } from "../../domain/ports/spend-ledger-port.js";
import type { VcsPort } from "../../domain/ports/vcs-port.js";
import type { PullRequestRef } from "../../domain/pull-request.js";
import {
  type SpendCapEvaluation,
  type SpendLedger,
  evaluateSpendCap,
  spendPeriodKey,
} from "../../domain/spend-cap.js";
import { jevCostUsd, pricingForModel } from "../findings/pricing.js";
import { type FindingFilterStageResult, runFindingFilterStage } from "./stages/finding-filter.js";
import { type HunkProfileStageResult, runHunkProfileStage } from "./stages/hunk-profile.js";
import { type MergeGateStageResult, runMergeGateStage } from "./stages/merge-gate.js";
import {
  buildFailClosedPublication,
  runPublishStage,
  runTriageOnlyPublishStage,
} from "./stages/publish.js";
import { type ReviewStageResult, runReviewStage } from "./stages/review.js";
import { type TriageStageResult, runTriageStage } from "./stages/triage.js";

export interface RunPipelineInput {
  readonly ref: PullRequestRef;
  readonly ports: {
    readonly vcs: VcsPort;
    readonly decision: DecisionPort;
    /** Not required when `config.reviewer.provider` is `"none"` (Jev-only mode) — the review stage never calls it. */
    readonly reviewer?: ReviewerPort;
    /**
     * Cumulative spend ledger behind `config.spendCap` (NFR-10). Optional:
     * without it the cap is not enforced and `spendCap` in the result is
     * `null`. Read/record failures never fail the run — see `readSpendCap`
     * and `recordSpend` below.
     */
    readonly spendLedger?: SpendLedgerPort;
  };
  readonly config: JevestConfig;
  /** Optional: full-file content at a given sha, for hunk-profile's §4.3 AST context. */
  readonly fetchFileContent?: (path: string, sha: string) => Promise<string | null>;
  /** Injectable clock for the spend cap's period key and ledger timestamps. Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface PipelineResult {
  readonly ref: PullRequestRef;
  readonly failedClosed: boolean;
  readonly failureReason: string | null;
  readonly triage: TriageStageResult | null;
  readonly hunkProfile: HunkProfileStageResult | null;
  readonly review: ReviewStageResult | null;
  readonly findingFilter: FindingFilterStageResult | null;
  readonly mergeGate: MergeGateStageResult | null;
  readonly publication: import("../../domain/ports/vcs-port.js").ReviewPublication;
  /**
   * Convenience top-level mirrors of `publication.check` and the
   * findings/cost totals, for callers (e.g. src/action/main.ts) that only
   * need the CI-facing summary rather than the full per-stage breakdown.
   */
  readonly check: import("../../domain/ports/vcs-port.js").ReviewPublication["check"];
  readonly findingsPublished: number;
  readonly costUsd: number;
  /**
   * Cumulative spend cap state (NFR-10) AFTER this run was recorded, or the
   * pre-run state when recording failed. `null` when no ledger port was
   * wired, the run ended before the review stage, or the ledger could not
   * be read (`spendLedgerError` then says why).
   */
  readonly spendCap: SpendCapEvaluation | null;
  /** True when the review stage was skipped because the cap was already reached before this run. */
  readonly reviewSkippedForSpendCap: boolean;
  /** Ledger read/record failure, if any. Never fails the run — surfaces in the summary comment instead. */
  readonly spendLedgerError: string | null;
}

type SpendFields = Pick<
  PipelineResult,
  "spendCap" | "reviewSkippedForSpendCap" | "spendLedgerError"
>;

const NO_SPEND_INFO: SpendFields = {
  spendCap: null,
  reviewSkippedForSpendCap: false,
  spendLedgerError: null,
};

function summaryFields(
  publication: import("../../domain/ports/vcs-port.js").ReviewPublication,
  findingFilter: FindingFilterStageResult | null,
  review: ReviewStageResult | null,
): Pick<PipelineResult, "check" | "findingsPublished" | "costUsd"> {
  return {
    check: publication.check,
    findingsPublished: findingFilter?.published.length ?? 0,
    costUsd: review?.totalCostUsd ?? 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the ledger and evaluates the cap BEFORE the review stage. A ledger
 * that cannot be read is reported, not fatal: the run proceeds on the full
 * per-run `budgetUsd` (status effectively "ok") and the summary carries a
 * "spend ledger unavailable" note, because a flaky issues API must not
 * turn every review into a fail-closed run.
 */
async function readSpendCap(
  spendLedger: SpendLedgerPort,
  config: JevestConfig,
  now: Date,
): Promise<{ evaluation: SpendCapEvaluation | null; error: string | null }> {
  try {
    const ledger = await spendLedger.read();
    return {
      evaluation: evaluateSpendCap({
        ledger,
        cap: config.spendCap,
        now,
        requestedBudgetUsd: config.budgetUsd,
      }),
      error: null,
    };
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`jevest: spend ledger unavailable (${message}); cumulative cap not enforced`);
    return { evaluation: null, error: message };
  }
}

/**
 * Books this run into the ledger right after the review stage — before
 * finding-filter/merge-gate can fail closed — so LLM money already spent
 * is never lost from the total. Jev's share counts triage + hunk-profile
 * input tokens (the stages that ran so far); finding-filter and merge-gate
 * tokens are left out on purpose, a rounding error at $0.042/MTok that is
 * not worth a second ledger write. Returns the post-run evaluation, or the
 * pre-run one when recording fails (again reported, never fatal).
 */
async function recordSpend(
  spendLedger: SpendLedgerPort,
  input: RunPipelineInput,
  now: Date,
  preRun: SpendCapEvaluation | null,
  jevInputTokens: number,
  llmUsd: number,
): Promise<{ evaluation: SpendCapEvaluation | null; error: string | null }> {
  let recorded: SpendLedger;
  try {
    recorded = await spendLedger.record({
      periodKey: spendPeriodKey(input.config.spendCap.period, now),
      prNumber: input.ref.number,
      headSha: input.ref.headSha,
      llmUsd,
      jevUsd: jevCostUsd(jevInputTokens),
      at: now.toISOString(),
    });
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`jevest: could not record spend in the ledger (${message})`);
    return { evaluation: preRun, error: message };
  }
  return {
    evaluation: evaluateSpendCap({
      ledger: recorded,
      cap: input.config.spendCap,
      now,
      requestedBudgetUsd: input.config.budgetUsd,
    }),
    error: null,
  };
}

function severityCounts(published: FindingFilterStageResult["published"]): Record<string, number> {
  const counts: Record<string, number> = { nit: 0, minor: 0, major: 0, critical: 0 };
  const levels = ["nit", "minor", "major", "critical"];
  for (const finding of published) {
    const level = levels[Math.min(3, Math.max(0, Math.round(finding.jevSeverityScore)))];
    if (level === undefined) continue; // unreachable given the clamp above
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

export async function runPipeline(input: RunPipelineInput): Promise<PipelineResult> {
  const { ports, config } = input;
  const pr = await ports.vcs.fetchPullRequest(input.ref);

  let triage: TriageStageResult;
  try {
    triage = await runTriageStage({
      pr,
      decisionPort: ports.decision,
      sizeThresholds: config.sizeThresholds,
      policyConfig: config.thresholds,
    });
  } catch {
    const publication = buildFailClosedPublication("triage", null);
    await ports.vcs.publishReview(input.ref, publication);
    return {
      ref: input.ref,
      failedClosed: true,
      failureReason: "triage",
      triage: null,
      hunkProfile: null,
      review: null,
      findingFilter: null,
      mergeGate: null,
      publication,
      ...summaryFields(publication, null, null),
      ...NO_SPEND_INFO,
    };
  }

  if (triage.skipLlmReview) {
    const publication = runTriageOnlyPublishStage(triage);
    await ports.vcs.publishReview(input.ref, publication);
    return {
      ref: input.ref,
      failedClosed: false,
      failureReason: null,
      triage,
      hunkProfile: null,
      review: null,
      findingFilter: null,
      mergeGate: null,
      publication,
      ...summaryFields(publication, null, null),
      ...NO_SPEND_INFO,
    };
  }

  // Cumulative spend cap (NFR-10): evaluated once here, before anything
  // that costs LLM money. "reached" turns this into a Jev-only run exactly
  // like reviewer.provider "none"; otherwise the review stage gets the
  // per-run budget clamped to what is left under the cap.
  const now = (input.now ?? (() => new Date()))();
  const preRun = ports.spendLedger
    ? await readSpendCap(ports.spendLedger, config, now)
    : { evaluation: null, error: null };
  const reviewSkippedForSpendCap = preRun.evaluation?.status === "reached";
  let spend: SpendFields = {
    spendCap: preRun.evaluation,
    reviewSkippedForSpendCap,
    spendLedgerError: preRun.error,
  };

  let hunkProfile: HunkProfileStageResult;
  try {
    hunkProfile = await runHunkProfileStage({
      pr,
      decisionPort: ports.decision,
      policyConfig: config.thresholds,
      riskLevel: triage.riskLevel,
      skipChangeKinds: config.skipChangeKinds,
      maxHunks: config.maxHunks,
      ...(input.fetchFileContent ? { fetchFileContent: input.fetchFileContent } : {}),
    });
  } catch {
    const publication = buildFailClosedPublication("hunk-profile", triage);
    await ports.vcs.publishReview(input.ref, publication);
    return {
      ref: input.ref,
      failedClosed: true,
      failureReason: "hunk-profile",
      triage,
      hunkProfile: null,
      review: null,
      findingFilter: null,
      mergeGate: null,
      publication,
      ...summaryFields(publication, null, null),
      ...spend,
    };
  }

  // The LLM reviewer is not Jev — its own per-hunk errors are already
  // handled inside runReviewStage (recorded, pipeline continues), so NFR-2
  // fail-closed doesn't apply to this call. reviewer.provider: "none" is
  // Jev-only mode: the review stage never runs at all, no LLM key needed.
  // A reached spend cap takes the same path (see above).
  const reviewDisabled = config.reviewer.provider === "none";
  let review: ReviewStageResult;
  if (reviewDisabled || reviewSkippedForSpendCap) {
    review = { reviews: [], totalCostUsd: 0, budgetExceeded: false, skippedForBudgetCount: 0 };
  } else {
    if (!ports.reviewer) {
      throw new Error(
        `internal: reviewer.provider is "${config.reviewer.provider}" but no ReviewerPort was provided`,
      );
    }
    review = await runReviewStage({
      hunks: hunkProfile.hunks,
      reviewerPort: ports.reviewer,
      // config validation guarantees model is set whenever provider isn't "none".
      pricing: pricingForModel(config.reviewer.model ?? config.reviewer.provider),
      budgetUsd: preRun.evaluation?.effectiveBudgetUsd ?? config.budgetUsd,
    });
  }

  if (ports.spendLedger) {
    const recorded = await recordSpend(
      ports.spendLedger,
      input,
      now,
      preRun.evaluation,
      triage.usage.inputTokens + hunkProfile.totalUsage.inputTokens,
      review.totalCostUsd,
    );
    spend = {
      spendCap: recorded.evaluation,
      reviewSkippedForSpendCap,
      spendLedgerError: [preRun.error, recorded.error].filter((e) => e !== null).join("; ") || null,
    };
  }

  const hunksById = new Map(hunkProfile.hunks.map((h) => [h.id, h.diff]));
  let findingFilter: FindingFilterStageResult;
  try {
    findingFilter = await runFindingFilterStage({
      reviews: review.reviews,
      hunksById,
      decisionPort: ports.decision,
      policyConfig: config.thresholds,
      riskLevel: triage.riskLevel,
    });
  } catch {
    const publication = buildFailClosedPublication("finding-filter", triage);
    await ports.vcs.publishReview(input.ref, publication);
    return {
      ref: input.ref,
      failedClosed: true,
      failureReason: "finding-filter",
      triage,
      hunkProfile,
      review,
      findingFilter: null,
      mergeGate: null,
      publication,
      ...summaryFields(publication, null, review),
      ...spend,
    };
  }

  const injectionThresholds = config.thresholds.triage?.[triage.riskLevel];
  const containsInjectedInstructionsHigh =
    injectionThresholds !== undefined &&
    triage.containsInjectedInstructionsProb >= injectionThresholds.confirmMin;

  let mergeGate: MergeGateStageResult;
  try {
    mergeGate = await runMergeGateStage({
      decisionPort: ports.decision,
      policyConfig: config.thresholds,
      riskLevel: triage.riskLevel,
      triageCategory: triage.category,
      publishedCountsBySeverity: severityCounts(findingFilter.published),
      ciStatus: pr.ciStatus,
      containsInjectedInstructionsHigh,
    });
  } catch {
    const publication = buildFailClosedPublication("merge-gate", triage);
    await ports.vcs.publishReview(input.ref, publication);
    return {
      ref: input.ref,
      failedClosed: true,
      failureReason: "merge-gate",
      triage,
      hunkProfile,
      review,
      findingFilter,
      mergeGate: null,
      publication,
      ...summaryFields(publication, findingFilter, review),
      ...spend,
    };
  }

  const publication = runPublishStage({
    triage,
    hunkProfile,
    review,
    findingFilter,
    mergeGate,
    inlineCommentsEnabled: config.publish.inlineComments,
    reviewDisabled,
    spendCap: spend.spendCap,
    reviewSkippedForSpendCap: spend.reviewSkippedForSpendCap,
    spendLedgerError: spend.spendLedgerError,
  });
  await ports.vcs.publishReview(input.ref, publication);

  return {
    ref: input.ref,
    failedClosed: false,
    failureReason: null,
    triage,
    hunkProfile,
    review,
    findingFilter,
    mergeGate,
    publication,
    ...summaryFields(publication, findingFilter, review),
    ...spend,
  };
}
