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
 *
 * Triage v2 (H7): the change summary is an LLM call made just before the
 * triage request, so it is gated here like the review stage — by
 * `config.triage.changeSummary` ("auto": only when an LLM reviewer is
 * configured and the spend cap is not reached; "always": mandatory, cap or
 * not; "never": off) — and its cost is booked into the ledger, the cost
 * breakdown and `costUsd` alongside the review's. The spend cap is
 * therefore read BEFORE triage. The product context (`.jevest/context.yml`
 * at the base sha) arrives already parsed from the composition root, so a
 * missing file is the empty context and an invalid one failed closed
 * before the pipeline started.
 *
 * Efficiency (H2 / H4): every run ends with `metrics` (run-metrics.ts),
 * never null. The stages already report each Jev call's latency and
 * usage; this file only adds the wall clock around each stage, taken from
 * the same injectable `now` the spend cap uses, and the diffs of the hunks
 * a triage skip never profiled (so the counterfactual can price them).
 * The metrics are computed once BEFORE publish, so the summary comment
 * can carry them, and once after, so `metrics.wallTime` includes publish.
 *
 * Colleague review: after the merge gate, one narrator call writes the
 * top of the summary comment from the findings Jev kept (stages/narrate.ts),
 * when `reviewer.narrative` is on and a ReviewNarratorPort is wired. It is
 * skipped — never failing the run — when the LLM review did not really
 * happen (Jev-only, spend cap reached, every reviewer call failed), when
 * the per-run budget is already spent, and when injected instructions were
 * suspected (the author's text and diff would reach an LLM that writes
 * the comment). Its cost is LLM money like the review's: it counts in
 * `costUsd` and in the ONE ledger write of the run, which therefore
 * happens after the narrator — or, on a fail-closed exit after the review
 * stage, right before publishing that failure, so spent money is never
 * lost from the total.
 *
 * Author context (stages/description-context.ts): right before the review
 * stage, one extractor call keeps the review-relevant part of the PR
 * description for the reviewer (and the narrator, in place of the raw
 * description) and drops every attempt to steer the review. It runs only
 * when `reviewer.descriptionContext` is on, a DescriptionContextPort is
 * wired, the LLM review really runs (not Jev-only, not a reached spend
 * cap, not a triage-only run) and the description is not blank; those
 * skips are silent. When triage flagged injected instructions in the
 * description (the same confirm bar the merge gate fails on) the extractor
 * is NOT called and nothing from the description reaches the reviewer; the
 * comment says so in one line. An extractor error never fails the run.
 * Its cost is LLM money like the others: it comes out of the per-run
 * budget before the review, and counts in `costUsd` and the ledger.
 *
 * Code context (stages/code-context.ts, `reviewer.fullFile` /
 * `reviewer.impactContext`): when the LLM review really runs, the hunks'
 * full files and the code that references what they change are read from
 * `ports.workingTree` (a checkout of the PR head) and ride on each
 * ReviewInput. Without a working tree nothing is built and the comment
 * says so in one line (`workingTreeUnavailableReason`); never a failure.
 * Its time counts in `wallTime.reviewMs`. `reviewer.requireEvidence` asks
 * for evidence and checks it against the same tree (or the hunk text). With
 * all three off the tree is never touched and every request is unchanged.
 *
 * Agentic mode (`reviewer.mode: agentic`, stages/agentic-review.ts and
 * agentic-judge.ts): ONE read-only agent per PR in the checkout at
 * `headCheckoutRoot` replaces the per-hunk review and the code-context
 * stage; hard exclusions, the evidence check, the optional verifier
 * (`reviewer.verifier`) and Jev's staged judge replace the finding filter.
 * Triage, hunk profile (secret warning, in-diff injection), description
 * context, merge gate, narrator, verdict, labels and publish are the same
 * stages as before. The agent's author context is the extractor's output
 * when it ran, otherwise the redacted description framed as untrusted
 * data, never either when triage flagged injected instructions. Without a
 * checkout the run fails closed to `unavailable` (never a silent fallback
 * to the per-hunk review). The verifier's cost counts in `costUsd`, the
 * ledger and the budget like every other LLM call. With `mode: hunks` none
 * of this runs and the result carries no `agentic` key.
 */
import { type CalibrationMap, NO_CALIBRATION } from "../../domain/calibration.js";
import { splitFileIntoHunks } from "../../domain/hunk-splitter.js";
import type { AgenticReviewerPort } from "../../domain/ports/agentic-reviewer-port.js";
import type { ChangeSummarizerPort } from "../../domain/ports/change-summarizer-port.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { DescriptionContextPort } from "../../domain/ports/description-context-port.js";
import type { FindingVerifierPort } from "../../domain/ports/finding-verifier-port.js";
import type { ReviewNarratorPort } from "../../domain/ports/review-narrator-port.js";
import type { ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { SpendLedgerPort } from "../../domain/ports/spend-ledger-port.js";
import type { VcsPort } from "../../domain/ports/vcs-port.js";
import type { WorkingTreePort } from "../../domain/ports/working-tree-port.js";
import type { PullRequestRef } from "../../domain/pull-request.js";
import {
  type SpendCapEvaluation,
  type SpendLedger,
  evaluateSpendCap,
  spendPeriodKey,
} from "../../domain/spend-cap.js";
import { EMPTY_PRODUCT_CONTEXT, type ProductContext } from "../context/product-context.js";
import { jevCostUsd, pricingForModel } from "../findings/pricing.js";
import {
  type RunMetrics,
  type StageWallTimes,
  ZERO_WALL_TIMES,
  computeRunMetrics,
} from "./run-metrics.js";
import { type AgenticJudgeDetails, runAgenticJudgeStage } from "./stages/agentic-judge.js";
import { type AgenticReviewStageResult, runAgenticReviewStage } from "./stages/agentic-review.js";
import {
  type CodeContextStageResult,
  createHeadFileReader,
  runCodeContextStage,
} from "./stages/code-context.js";
import {
  type DescriptionContextStageResult,
  descriptionContextSkipped,
  reviewerAuthorContext,
  runDescriptionContextStage,
} from "./stages/description-context.js";
import { type FindingFilterStageResult, runFindingFilterStage } from "./stages/finding-filter.js";
import {
  type HunkProfileStageResult,
  injectedInstructionsInDiffWord,
  runHunkProfileStage,
} from "./stages/hunk-profile.js";
import { type MergeGateStageResult, runMergeGateStage } from "./stages/merge-gate.js";
import { type NarrateStageResult, narrativeSkipped, runNarrateStage } from "./stages/narrate.js";
import {
  allReviewsFailed,
  buildFailClosedPublication,
  resolvePublishVerdict,
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
     * Writes the change summary triage compares the description against
     * (H7). Required only when `config.triage.changeSummary` is "always";
     * under "auto" it is used when present, under "never" it is ignored.
     */
    readonly summarizer?: ChangeSummarizerPort;
    /**
     * Writes the colleague review (stages/narrate.ts). Used only when
     * `config.reviewer.narrative` is true; without it the comment is the
     * plain report, exactly as before.
     */
    readonly narrator?: ReviewNarratorPort;
    /**
     * Extracts the author's stated context from the PR description for the
     * reviewer (stages/description-context.ts). Used only when
     * `config.reviewer.descriptionContext` is true; without it the reviewer
     * never sees the description, exactly as before.
     */
    readonly descriptionContext?: DescriptionContextPort;
    /**
     * Cumulative spend ledger behind `config.spendCap` (NFR-10). Optional:
     * without it the cap is not enforced and `spendCap` in the result is
     * `null`. Read/record failures never fail the run — see `readSpendCap`
     * and `recordSpend` below.
     */
    readonly spendLedger?: SpendLedgerPort;
    /**
     * The working tree at the PR head (stages/code-context.ts). Used only
     * when `reviewer.fullFile`, `reviewer.impactContext` or
     * `reviewer.requireEvidence` is on; absent = no checkout.
     */
    readonly workingTree?: WorkingTreePort;
    /** The one-agent-per-PR reviewer. Required when `config.reviewer.mode` is "agentic"; ignored otherwise. */
    readonly agenticReviewer?: AgenticReviewerPort;
    /** The per-finding LLM verifier. Required when `config.reviewer.verifier` is not "none" (agentic mode only). */
    readonly findingVerifier?: FindingVerifierPort;
  };
  /** Why there is no `ports.workingTree`, for the comment's one line. Default "no checkout". */
  readonly workingTreeUnavailableReason?: string;
  /**
   * Absolute path of the checkout behind `ports.workingTree`: the agentic
   * reviewer's and verifier's cwd. Agentic mode without it (or without the
   * working tree) is `unavailable`.
   */
  readonly headCheckoutRoot?: string;
  readonly config: JevestConfig;
  /** Optional: full-file content at a given sha, for hunk-profile's §4.3 AST context. */
  readonly fetchFileContent?: (path: string, sha: string) => Promise<string | null>;
  /** Parsed `.jevest/context.yml` from the PR's BASE sha (see context/product-context.ts). Default: empty. */
  readonly productContext?: ProductContext;
  /**
   * Parsed calibration map for `is_real_defect`, fetched from the PR's BASE
   * sha by the caller (src/action/main.ts, scripts/review/run.ts). Applied by
   * stage 4 ONLY when `config.findingFilter.calibration` is `"file"` — the
   * config is what decides, so a map that arrived some other way can never
   * turn calibration on behind the config's back. Default: the identity.
   */
  readonly calibration?: CalibrationMap;
  /** Injectable clock for the spend cap's period key, ledger timestamps and the per-stage wall time in `metrics`. Default: `new Date()`. */
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
  /** The colleague review; `null` when the narrator was not configured or not applicable (see the module doc). */
  readonly narrative: NarrateStageResult | null;
  /** What the reviewer got from the PR description; `null` when the extractor was not configured or not applicable (see the module doc). */
  readonly descriptionContext: DescriptionContextStageResult | null;
  /** The code context built for the reviewer; `null` when `reviewer.fullFile` and `reviewer.impactContext` are off or the review did not run. */
  readonly codeContext: CodeContextStageResult | null;
  readonly publication: import("../../domain/ports/vcs-port.js").ReviewPublication;
  /**
   * Convenience top-level mirrors of `publication.check` and the
   * findings/cost totals, for callers (e.g. src/action/main.ts) that only
   * need the CI-facing summary rather than the full per-stage breakdown.
   */
  readonly check: import("../../domain/ports/vcs-port.js").ReviewPublication["check"];
  readonly findingsPublished: number;
  /** `findingFilter.lowConfidence.length` (`mode: "annotate"` only; 0 in `mode: "discard"`). See stages/finding-filter.ts. */
  readonly findingsLowConfidence: number;
  /** LLM money spent on this run: the review stage, the change summary, the description context and the review narrative. */
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
  /** H2 / H4 per-run numbers (run-metrics.ts); zeros for the stages that did not run, never null. */
  readonly metrics: RunMetrics;
  /** Agentic mode only (absent in the per-hunk mode): the agent run and the judge's details. */
  readonly agentic?: AgenticRunResult;
}

export interface AgenticRunResult {
  readonly review: AgenticReviewStageResult;
  /** `null` when the judge did not run (the run ended before it). */
  readonly judge: AgenticJudgeDetails | null;
}

type StageResults = Pick<
  PipelineResult,
  "triage" | "hunkProfile" | "review" | "findingFilter" | "mergeGate"
>;

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
  triage: TriageStageResult | null = null,
  narrative: NarrateStageResult | null = null,
  descriptionContext: DescriptionContextStageResult | null = null,
  agentic: AgenticRunResult | null = null,
): Pick<PipelineResult, "check" | "findingsPublished" | "findingsLowConfidence" | "costUsd"> {
  return {
    check: publication.check,
    findingsPublished: findingFilter?.published.length ?? 0,
    findingsLowConfidence: findingFilter?.lowConfidence.length ?? 0,
    costUsd:
      (review?.totalCostUsd ?? 0) +
      (triage?.summaryCostUsd ?? 0) +
      (descriptionContext?.costUsd ?? 0) +
      (narrative?.costUsd ?? 0) +
      (agentic?.judge?.verifierCostUsd ?? 0),
  };
}

/**
 * Whether the change summary runs on this PR (H7), resolved from
 * `triage.changeSummary` and the spend cap. "auto" treats a reached cap
 * exactly like the review stage does (a Jev-only run spends nothing on the
 * LLM); "always" is the consumer saying the summary is worth its call
 * regardless, and it is a config error to say so without a provider.
 */
function summarizerForTriage(
  input: RunPipelineInput,
  capReached: boolean,
): ChangeSummarizerPort | undefined {
  const mode = input.config.triage.changeSummary;
  if (mode === "never") {
    return undefined;
  }
  if (mode === "always") {
    if (!input.ports.summarizer) {
      throw new Error(
        'internal: triage.changeSummary is "always" but no ChangeSummarizerPort was provided',
      );
    }
    return input.ports.summarizer;
  }
  if (input.config.reviewer.provider === "none" || capReached) {
    return undefined;
  }
  return input.ports.summarizer;
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
 * Books this run into the ledger, once: after the narrator on a full run,
 * or right before publishing a fail-closed result past the review stage,
 * so LLM money already spent is never lost from the total. Jev's share
 * counts triage + hunk-profile input tokens; finding-filter and merge-gate
 * tokens are left out on purpose, a rounding error at $0.042/MTok. Returns
 * the post-run evaluation, or the pre-run one when recording fails (again
 * reported, never fatal).
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
  const clock = input.now ?? (() => new Date());
  const now = clock();
  const pr = await ports.vcs.fetchPullRequest(input.ref);

  // Wall clock per stage (H4): one `clock()` at each stage boundary, so a
  // test with a ticking clock sees exactly one tick per stage. `finally`
  // keeps the time of a stage that threw, since the fail-closed result
  // reports metrics too.
  const wall: { -readonly [K in keyof StageWallTimes]: number } = { ...ZERO_WALL_TIMES };
  const elapsed = (): number => clock().getTime() - now.getTime();
  async function timed<T>(stage: keyof StageWallTimes, run: () => Promise<T>): Promise<T> {
    const start = elapsed();
    try {
      return await run();
    } finally {
      wall[stage] = elapsed() - start;
    }
  }

  const reviewDisabled = config.reviewer.provider === "none";
  let reviewSkippedForSpendCap = false;
  // Set right before the review stage; a fail-closed exit after it still reports it (and its cost).
  let descriptionContext: DescriptionContextStageResult | null = null;
  let codeContext: CodeContextStageResult | null = null;
  let agentic: AgenticRunResult | null = null;
  const agenticFields = (): { agentic?: AgenticRunResult } => (agentic ? { agentic } : {});
  let unprofiledHunkDiffs: readonly string[] = [];
  const metricsFor = (stages: StageResults): RunMetrics =>
    computeRunMetrics({
      ...stages,
      codeContext,
      agentic,
      unprofiledHunkDiffs,
      reviewSkippedForSpendCap,
      reviewDisabled,
      wallTime: { ...wall, totalMs: elapsed() },
    });

  const failClosed = async (
    stage: string,
    stages: StageResults,
    spendFields: SpendFields,
  ): Promise<PipelineResult> => {
    const publication = buildFailClosedPublication(
      stage,
      stages.triage,
      undefined,
      config.reviewer.language,
    );
    await timed("publishMs", () => ports.vcs.publishReview(input.ref, publication));
    return {
      ref: input.ref,
      failedClosed: true,
      failureReason: stage,
      ...stages,
      narrative: null,
      descriptionContext,
      codeContext,
      publication,
      ...summaryFields(
        publication,
        stages.findingFilter,
        stages.review,
        stages.triage,
        null,
        descriptionContext,
        agentic,
      ),
      ...spendFields,
      metrics: metricsFor(stages),
      ...agenticFields(),
    };
  };

  // Cumulative spend cap (NFR-10): evaluated once here, before anything
  // that costs LLM money — and the change summary (H7) is the first such
  // thing, so this now precedes triage. "reached" turns this into a
  // Jev-only run exactly like reviewer.provider "none"; otherwise the
  // review stage gets the per-run budget clamped to what is left under
  // the cap.
  const preRun = ports.spendLedger
    ? await readSpendCap(ports.spendLedger, config, now)
    : { evaluation: null, error: null };
  reviewSkippedForSpendCap = preRun.evaluation?.status === "reached";
  let spend: SpendFields = {
    spendCap: preRun.evaluation,
    reviewSkippedForSpendCap,
    spendLedgerError: preRun.error,
  };

  const summarizer = summarizerForTriage(input, reviewSkippedForSpendCap);

  let triage: TriageStageResult;
  try {
    triage = await timed("triageMs", () =>
      runTriageStage({
        pr,
        decisionPort: ports.decision,
        sizeThresholds: config.sizeThresholds,
        policyConfig: config.thresholds,
        productContext: input.productContext ?? EMPTY_PRODUCT_CONTEXT,
        ...(summarizer ? { summarizer } : {}),
        summaryPricing: pricingForModel(config.reviewer.model ?? config.reviewer.provider),
      }),
    );
  } catch {
    return failClosed(
      "triage",
      { triage: null, hunkProfile: null, review: null, findingFilter: null, mergeGate: null },
      NO_SPEND_INFO,
    );
  }

  // The summary is LLM money already spent: book it before any path that
  // ends the run early, so a triage-only run or a later fail-closed never
  // loses it from the ledger. Runs that spent nothing keep the old
  // behavior (no ledger write, `spendCap` null on a triage-only run).
  const bookSummaryOnly = async (): Promise<SpendFields> => {
    if (!ports.spendLedger || triage.summaryCostUsd <= 0) {
      return triage.summaryCostUsd > 0 ? spend : NO_SPEND_INFO;
    }
    const recorded = await recordSpend(
      ports.spendLedger,
      input,
      now,
      preRun.evaluation,
      triage.usage.inputTokens,
      triage.summaryCostUsd,
    );
    return {
      spendCap: recorded.evaluation,
      reviewSkippedForSpendCap,
      spendLedgerError: [preRun.error, recorded.error].filter((e) => e !== null).join("; ") || null,
    };
  };

  if (triage.skipLlmReview) {
    // The hunks the skip kept from being profiled, split exactly as the
    // hunk-profile stage would have (same cap), so H2 can price them.
    unprofiledHunkDiffs = pr.files
      .flatMap((file) => splitFileIntoHunks(file.path, file.patch))
      .slice(0, config.maxHunks)
      .map((hunk) => hunk.diff);
    const stages: StageResults = {
      triage,
      hunkProfile: null,
      review: null,
      findingFilter: null,
      mergeGate: null,
    };
    const spendFields = await bookSummaryOnly();
    const publication = runTriageOnlyPublishStage(
      triage,
      metricsFor(stages),
      config.reviewer.language,
    );
    await timed("publishMs", () => ports.vcs.publishReview(input.ref, publication));
    return {
      ref: input.ref,
      failedClosed: false,
      failureReason: null,
      ...stages,
      narrative: null,
      descriptionContext: null,
      codeContext: null,
      publication,
      ...summaryFields(publication, null, null, triage),
      ...spendFields,
      metrics: metricsFor(stages),
    };
  }

  let hunkProfile: HunkProfileStageResult;
  try {
    hunkProfile = await timed("hunkProfileMs", () =>
      runHunkProfileStage({
        pr,
        decisionPort: ports.decision,
        policyConfig: config.thresholds,
        riskLevel: triage.riskLevel,
        skipChangeKinds: config.skipChangeKinds,
        maxHunks: config.maxHunks,
        ...(input.fetchFileContent ? { fetchFileContent: input.fetchFileContent } : {}),
      }),
    );
  } catch {
    return failClosed(
      "hunk-profile",
      { triage, hunkProfile: null, review: null, findingFilter: null, mergeGate: null },
      triage.summaryCostUsd > 0 ? await bookSummaryOnly() : spend,
    );
  }

  // Triage's injection flag in the description, resolved against its
  // confirm bar: the same flag the merge gate fails on, and the gate that
  // keeps the description away from the reviewer (see the module doc).
  const injectionThresholds = config.thresholds.triage?.[triage.riskLevel];
  const containsInjectedInstructionsHigh =
    injectionThresholds !== undefined &&
    triage.containsInjectedInstructionsProb >= injectionThresholds.confirmMin;

  // The LLM reviewer is not Jev — its own per-hunk errors are already
  // handled inside runReviewStage (recorded, pipeline continues), so NFR-2
  // fail-closed doesn't apply to this call. reviewer.provider: "none" is
  // Jev-only mode: the review stage never runs at all, no LLM key needed.
  // A reached spend cap takes the same path (see above).
  // The change summary already spent part of this run's budget (H7).
  const budgetAfterSummaryUsd = Math.max(
    0,
    (preRun.evaluation?.effectiveBudgetUsd ?? config.budgetUsd) - triage.summaryCostUsd,
  );
  descriptionContext = await extractDescriptionContext({
    input,
    pr,
    reviewRuns: !reviewDisabled && !reviewSkippedForSpendCap,
    budgetUsd: budgetAfterSummaryUsd,
    containsInjectedInstructionsHigh,
  });
  // The author context, like the summary, already spent part of the budget.
  const reviewBudgetUsd = Math.max(0, budgetAfterSummaryUsd - (descriptionContext?.costUsd ?? 0));
  const authorContext = reviewerAuthorContext(descriptionContext);
  let review: ReviewStageResult;
  const agenticMode = config.reviewer.mode === "agentic";
  // Agentic mode needs the checkout's path AND its working tree (the judge
  // re-reads the evidence through it); either missing is "no checkout".
  const agenticRoot =
    input.headCheckoutRoot !== undefined && ports.workingTree !== undefined
      ? input.headCheckoutRoot
      : undefined;
  if (reviewDisabled || reviewSkippedForSpendCap) {
    review = { reviews: [], totalCostUsd: 0, budgetExceeded: false, skippedForBudgetCount: 0 };
  } else if (agenticMode) {
    const agenticReviewer = ports.agenticReviewer;
    if (!agenticReviewer) {
      throw new Error(
        'internal: reviewer.mode is "agentic" but no AgenticReviewerPort was provided',
      );
    }
    if (config.reviewer.verifier !== "none" && !ports.findingVerifier) {
      throw new Error(
        `internal: reviewer.verifier is "${config.reviewer.verifier}" but no FindingVerifierPort was provided`,
      );
    }
    // The raw description only when no extractor result exists (or it
    // failed), and never when triage flagged injected instructions.
    const rawDescription =
      !containsInjectedInstructionsHigh &&
      (descriptionContext === null || descriptionContext.status === "failed")
        ? pr.body
        : undefined;
    const agenticReview = await timed("reviewMs", () =>
      runAgenticReviewStage({
        pr,
        hunkProfile,
        reviewer: agenticReviewer,
        repoRoot: agenticRoot,
        unavailableReason: input.workingTreeUnavailableReason,
        authorContext,
        description: rawDescription,
        budgetUsd: reviewBudgetUsd,
      }),
    );
    agentic = { review: agenticReview, judge: null };
    review = agenticReview.review;
  } else {
    if (!ports.reviewer) {
      throw new Error(
        `internal: reviewer.provider is "${config.reviewer.provider}" but no ReviewerPort was provided`,
      );
    }
    const reviewerPort = ports.reviewer;
    const { workingTree } = ports;
    review = await timed("reviewMs", async () => {
      if (config.reviewer.fullFile || config.reviewer.impactContext) {
        codeContext = await runCodeContextStage({
          hunks: hunkProfile.hunks,
          ...(workingTree ? { workingTree } : {}),
          ...(input.workingTreeUnavailableReason
            ? { unavailableReason: input.workingTreeUnavailableReason }
            : {}),
          fullFile: config.reviewer.fullFile,
          impactContext: config.reviewer.impactContext,
        });
      }
      return runReviewStage({
        hunks: hunkProfile.hunks,
        reviewerPort,
        // config validation guarantees model is set whenever provider isn't "none".
        pricing: pricingForModel(config.reviewer.model ?? config.reviewer.provider),
        budgetUsd: reviewBudgetUsd,
        ...(authorContext ? { authorContext } : {}),
        ...(codeContext ? { codeContext } : {}),
        ...(config.reviewer.requireEvidence
          ? {
              requireEvidence: true,
              ...(workingTree ? { readHeadLines: createHeadFileReader(workingTree) } : {}),
            }
          : {}),
      });
    });
  }

  // The run's single ledger write (see `recordSpend`); `extraLlmUsd` is the
  // narrative's cost on a full run, 0 on a fail-closed exit.
  const bookRunSpend = async (extraLlmUsd: number): Promise<SpendFields> => {
    if (!ports.spendLedger) {
      return spend;
    }
    const recorded = await recordSpend(
      ports.spendLedger,
      input,
      now,
      preRun.evaluation,
      triage.usage.inputTokens + hunkProfile.totalUsage.inputTokens,
      review.totalCostUsd +
        triage.summaryCostUsd +
        (descriptionContext?.costUsd ?? 0) +
        (agentic?.judge?.verifierCostUsd ?? 0) +
        extraLlmUsd,
    );
    return {
      spendCap: recorded.evaluation,
      reviewSkippedForSpendCap,
      spendLedgerError: [preRun.error, recorded.error].filter((e) => e !== null).join("; ") || null,
    };
  };

  const hunksById = new Map(hunkProfile.hunks.map((h) => [h.id, h.diff]));
  let findingFilter: FindingFilterStageResult;
  try {
    const agenticRun = agentic;
    findingFilter = await timed("findingFilterMs", async () => {
      if (agenticRun === null) return runPerHunkFindingFilter();
      const judge = await runAgenticJudgeStage({
        findings: agenticRun.review.findings,
        pr,
        decisionPort: ports.decision,
        mode: config.findingFilter.mode,
        readHeadLines: ports.workingTree ? createHeadFileReader(ports.workingTree) : undefined,
        verifier: config.reviewer.verifier !== "none" ? ports.findingVerifier : undefined,
        repoRoot: agenticRoot,
        verifierBudgetUsd: Math.max(0, reviewBudgetUsd - review.totalCostUsd),
      });
      agentic = { ...agenticRun, judge: judge.details };
      return judge.filter;
    });
  } catch {
    return failClosed(
      "finding-filter",
      { triage, hunkProfile, review, findingFilter: null, mergeGate: null },
      await bookRunSpend(0),
    );
  }

  function runPerHunkFindingFilter(): Promise<FindingFilterStageResult> {
    return runFindingFilterStage({
      reviews: review.reviews,
      hunksById,
      decisionPort: ports.decision,
      policyConfig: config.thresholds,
      riskLevel: triage.riskLevel,
      mode: config.findingFilter.mode,
      calibration:
        config.findingFilter.calibration === "file"
          ? (input.calibration ?? NO_CALIBRATION)
          : NO_CALIBRATION,
    });
  }

  let mergeGate: MergeGateStageResult;
  try {
    mergeGate = await timed("mergeGateMs", () =>
      runMergeGateStage({
        decisionPort: ports.decision,
        policyConfig: config.thresholds,
        riskLevel: triage.riskLevel,
        triageCategory: triage.category,
        publishedCountsBySeverity: severityCounts(findingFilter.published),
        ciStatus: pr.ciStatus,
        containsInjectedInstructionsHigh,
        // NFR-7 in the diff: the hunk profile's max probability, as a word (NFR-5).
        injectedInstructionsInDiff: injectedInstructionsInDiffWord(
          hunkProfile.injectedInstructionsInDiff.maxProb,
        ),
        descriptionMatchesChange: triage.descriptionMatchesChange,
        productAreasTouched: triage.productContext.areas.map((a) => ({
          name: a.name,
          criticality: a.criticality,
        })),
      }),
    );
  } catch {
    return failClosed(
      "merge-gate",
      { triage, hunkProfile, review, findingFilter, mergeGate: null },
      await bookRunSpend(0),
    );
  }

  const stages = { triage, hunkProfile, review, findingFilter, mergeGate };
  const narrative = await narrate({
    input,
    pr,
    stages,
    reviewDisabled,
    reviewSkippedForSpendCap,
    containsInjectedInstructionsHigh,
    injectionSuspected:
      containsInjectedInstructionsHigh ||
      injectedInstructionsInDiffWord(hunkProfile.injectedInstructionsInDiff.maxProb) === "yes",
    remainingBudgetUsd:
      reviewBudgetUsd - review.totalCostUsd - (agentic?.judge?.verifierCostUsd ?? 0),
    descriptionContext,
  });
  spend = await bookRunSpend(narrative?.costUsd ?? 0);

  const publication = runPublishStage({
    ...stages,
    inlineCommentsEnabled: config.publish.inlineComments,
    reviewDisabled,
    spendCap: spend.spendCap,
    reviewSkippedForSpendCap: spend.reviewSkippedForSpendCap,
    spendLedgerError: spend.spendLedgerError,
    metrics: metricsFor(stages),
    narrative,
    language: config.reviewer.language,
    injectedInstructionsInDescription: containsInjectedInstructionsHigh,
    descriptionContext,
  });
  await timed("publishMs", () => ports.vcs.publishReview(input.ref, publication));

  return {
    ref: input.ref,
    failedClosed: false,
    failureReason: null,
    ...stages,
    narrative,
    descriptionContext,
    codeContext,
    publication,
    ...summaryFields(
      publication,
      findingFilter,
      review,
      triage,
      narrative,
      descriptionContext,
      agentic,
    ),
    ...spend,
    metrics: metricsFor(stages),
    ...agenticFields(),
  };
}

interface NarrateInput {
  readonly input: RunPipelineInput;
  readonly pr: import("../../domain/pull-request.js").PullRequestData;
  readonly stages: {
    readonly triage: TriageStageResult;
    readonly hunkProfile: HunkProfileStageResult;
    readonly review: ReviewStageResult;
    readonly findingFilter: FindingFilterStageResult;
    readonly mergeGate: MergeGateStageResult;
  };
  readonly reviewDisabled: boolean;
  readonly reviewSkippedForSpendCap: boolean;
  /** Triage's injection flag, resolved against its confirm bar (same as the merge gate's). */
  readonly containsInjectedInstructionsHigh: boolean;
  readonly injectionSuspected: boolean;
  /** What is left of this run's budget after the summary and the review. */
  readonly remainingBudgetUsd: number;
  /** The author-context extraction, if any: an extracted one replaces the raw description for the narrator. */
  readonly descriptionContext: DescriptionContextStageResult | null;
}

/**
 * Whether and how the colleague review runs (see the module doc). `null`
 * means "not applicable, say nothing": no narrator configured, or no real
 * LLM review to narrate (the comment already explains why). A skip the
 * reader would not otherwise understand gets a note instead.
 */
async function narrate(args: NarrateInput): Promise<NarrateStageResult | null> {
  const { input, stages } = args;
  const narrator = input.ports.narrator;
  const reviewRan = !args.reviewDisabled && !args.reviewSkippedForSpendCap;
  if (!input.config.reviewer.narrative || narrator === undefined || !reviewRan) {
    return null;
  }
  if (allReviewsFailed(stages.review)) {
    return null;
  }
  if (stages.review.budgetExceeded || args.remainingBudgetUsd <= 0) {
    return narrativeSkipped("the per-run budgetUsd is spent");
  }
  if (args.injectionSuspected) {
    return narrativeSkipped("suspected instructions to a reviewer in the pull request");
  }
  return runNarrateStage({
    pr: args.pr,
    hunkProfile: stages.hunkProfile,
    review: stages.review,
    findingFilter: stages.findingFilter,
    // The same verdict, and so the same words, as the check (publish.ts).
    verdict: resolvePublishVerdict({
      ...stages,
      reviewDisabled: args.reviewDisabled,
      reviewSkippedForSpendCap: args.reviewSkippedForSpendCap,
      injectedInstructionsInDescription: args.containsInjectedInstructionsHigh,
    }).verdict,
    narrator,
    language: input.config.reviewer.language,
    pricing: pricingForModel(input.config.reviewer.model ?? input.config.reviewer.provider),
    ...(args.descriptionContext?.context ? { authorContext: args.descriptionContext.context } : {}),
  });
}

interface ExtractDescriptionContextInput {
  readonly input: RunPipelineInput;
  readonly pr: import("../../domain/pull-request.js").PullRequestData;
  /** The LLM review will really run: not Jev-only, not a reached spend cap. */
  readonly reviewRuns: boolean;
  /** This run's budget left after the change summary. */
  readonly budgetUsd: number;
  readonly containsInjectedInstructionsHigh: boolean;
}

/**
 * Whether and how the author context is extracted (see the module doc).
 * `null` means "not applicable, say nothing"; the injection gate is the one
 * skip the reader is told about, since it is a security decision.
 */
async function extractDescriptionContext(
  args: ExtractDescriptionContextInput,
): Promise<DescriptionContextStageResult | null> {
  const { config, ports } = args.input;
  const extractor = ports.descriptionContext;
  if (!config.reviewer.descriptionContext || extractor === undefined || !args.reviewRuns) {
    return null;
  }
  if (args.pr.body.trim() === "" || args.budgetUsd <= 0) {
    return null;
  }
  if (args.containsInjectedInstructionsHigh) {
    return descriptionContextSkipped("suspected instructions to a reviewer in the description");
  }
  return runDescriptionContextStage({
    pr: args.pr,
    extractor,
    language: config.reviewer.language,
    pricing: pricingForModel(config.reviewer.model ?? config.reviewer.provider),
  });
}
