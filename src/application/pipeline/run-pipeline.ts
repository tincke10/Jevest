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
import type { VcsPort } from "../../domain/ports/vcs-port.js";
import type { PullRequestRef } from "../../domain/pull-request.js";
import {
  CLAUDE_OPUS_5_PRICING,
  CLAUDE_SONNET_5_PRICING,
  type ModelPricing,
} from "../findings/pricing.js";
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
    readonly reviewer: ReviewerPort;
  };
  readonly config: JevestConfig;
  /** Optional: full-file content at a given sha, for hunk-profile's §4.3 AST context. */
  readonly fetchFileContent?: (path: string, sha: string) => Promise<string | null>;
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
}

function pricingFor(model: string): ModelPricing {
  return model.includes("opus") ? CLAUDE_OPUS_5_PRICING : CLAUDE_SONNET_5_PRICING;
}

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
    };
  }

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
    };
  }

  // The LLM reviewer is not Jev — its own per-hunk errors are already
  // handled inside runReviewStage (recorded, pipeline continues), so NFR-2
  // fail-closed doesn't apply to this call.
  const review = await runReviewStage({
    hunks: hunkProfile.hunks,
    reviewerPort: ports.reviewer,
    pricing: pricingFor(config.reviewer.model),
    budgetUsd: config.budgetUsd,
  });

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
    };
  }

  const publication = runPublishStage({ triage, hunkProfile, review, findingFilter, mergeGate });
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
  };
}
