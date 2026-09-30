/**
 * Stage 6: publish (SPEC FR-7). Pure data transform — no ports, no I/O — so
 * it stays synchronous, unlike the other stages. Builds the VcsPort-shaped
 * `ReviewPublication` from every prior stage's result: inline comments only
 * for auto-band findings (`findingFilter.published`); a markdown summary
 * covering the triage decision, skipped hunks, needs-human findings,
 * discarded count, low-confidence findings and cost breakdown; and the
 * labels/check for the merge gate outcome. Fingerprints are `sha256` of
 * stable content (path/line/claim for a comment, the whole summary text for
 * the summary) so a re-run over unchanged input reproduces the exact same
 * fingerprints (NFR-12).
 *
 * Stage 4 annotate mode (H1 pending, product decision 2026-09-22, see
 * stages/finding-filter.ts): `findingFilter.lowConfidence` — findings that
 * would have been discarded — is rendered in a collapsed "Low-confidence
 * findings" section, never as inline comments, never affecting the merge
 * gate, but INCLUDED in the fingerprint (it is review content, not timing).
 *
 * Triage v2 (H7) adds an "Intent vs change" section (what the change
 * summary says, product areas touched with their criticality, the
 * description-vs-change verdict with its probability, the product-owner
 * flag), two labels (`jevest:description-mismatch`,
 * `jevest:needs-product-owner`) and one consequence on the check: a
 * mismatch in the AUTO band forces a green check to neutral and lists the
 * PR in the human queue. It never turns a check red on its own — that is
 * the merge gate's call.
 *
 * In-diff injection (NFR-7): the Triage section reports both injection
 * probabilities (triage's, over the description; the hunk profile's, over
 * the diff) and the flagged hunks; at or above the hunk profile's "yes"
 * bar the PR gets `jevest:injected-instructions` and a human-queue line
 * naming the hunks. The red check itself comes from the merge gate, which
 * already failed in code on the same verdict.
 *
 * Efficiency (H2 / H4, run-metrics.ts): the last section of every summary
 * reports the run's Jev request count, p95 latency and total Jev time, the
 * hunks reviewed vs skipped by reason, the LLM tokens spent and the
 * ESTIMATED tokens saved, with one line saying it is an estimate. It is
 * deliberately last and EXCLUDED from `summaryFingerprint`: latency varies
 * between two runs over the same commit, and NFR-12's fingerprint promises
 * to cover the review's content, not its timing.
 *
 * Reviewer failures: a hunk whose reviewer call threw (e.g. an expired
 * token) has no findings, which reads exactly like a clean review. When
 * any did, an "LLM review failed" warning with the distinct error messages
 * comes BEFORE every findings section, the empty-findings lines stop
 * claiming a review happened if none did, and the check title/summary say
 * so. The warning IS fingerprinted (a failed run must not look like an
 * identical clean one). A partial failure leaves the check conclusion to
 * the merge gate. When EVERY attempted call failed, NFR-2 fails closed in
 * code: the check is at most neutral, auto-merge-ok is never applied and
 * the PR gets `jevest:needs-human` plus a line in the human queue — Jev's
 * gate only saw "zero findings", which is not a review.
 *
 * Colleague review (stages/narrate.ts): when the narrator wrote a review,
 * it is the TOP of the summary comment under a "## Review" heading in
 * `reviewer.language`; the "LLM review failed" warning, if any, stays
 * visible right under it; everything else this module renders (triage,
 * intent vs change, findings, skipped hunks, cost, merge gate, efficiency)
 * moves into ONE collapsed `<details>` block. Without a narrative the
 * comment is the plain report, headed by a one-line note when the narrator
 * failed or was skipped. The fingerprint never covers the narrative: an
 * LLM rewording the same findings is not new review content, and hashing
 * it would make every re-run look like a change (see `renderSummary`).
 * Inline comments, labels and the check are identical either way.
 */
import { createHash } from "node:crypto";
import { mapBeforeLineToAfterLine } from "../../../domain/hunk-splitter.js";
import type { InlineComment, ReviewPublication } from "../../../domain/ports/vcs-port.js";
import { describeReviewerError, isAuthenticationFailure } from "../../../domain/reviewer-error.js";
import type { SpendCapEvaluation } from "../../../domain/spend-cap.js";
import type { LlmSkippedHunks, RunMetrics } from "../run-metrics.js";
import { type FindingFilterStageResult, noulConfidence } from "./finding-filter.js";
import {
  type HunkProfileEntry,
  type HunkProfileStageResult,
  INJECTED_INSTRUCTIONS_IN_DIFF_YES_MIN_PROB,
} from "./hunk-profile.js";
import type { MergeGateStageResult } from "./merge-gate.js";
import type { NarrateStageResult } from "./narrate.js";
import type { ReviewStageEntry, ReviewStageResult } from "./review.js";
import type { TriageStageResult } from "./triage.js";

export interface PublishStageInput {
  readonly triage: TriageStageResult;
  readonly hunkProfile: HunkProfileStageResult;
  readonly review: ReviewStageResult;
  readonly findingFilter: FindingFilterStageResult;
  readonly mergeGate: MergeGateStageResult;
  /**
   * `.jevest.yml`'s `publish.inlineComments` (default true). When false, no
   * inline comments are published at all — auto-band findings are listed
   * in the summary comment instead, under "Findings (high confidence)".
   * Check status and labels are unaffected either way.
   */
  readonly inlineCommentsEnabled: boolean;
  /** True when `reviewer.provider: "none"` (Jev-only mode) — the review stage never ran. */
  readonly reviewDisabled: boolean;
  /**
   * Cumulative spend cap state AFTER this run was recorded (NFR-10, see
   * src/domain/spend-cap.ts). `undefined`/`null` means unknown: no ledger
   * port was wired, or reading it failed (then `spendLedgerError` says
   * why). Labels are only touched when an evaluation is present.
   */
  readonly spendCap?: SpendCapEvaluation | null;
  /** True when the review stage was skipped because the cap was already reached before this run. */
  readonly reviewSkippedForSpendCap?: boolean;
  /** Why the ledger could not be read/recorded, for the summary note; `null` when it worked. */
  readonly spendLedgerError?: string | null;
  /** The run's H2 / H4 numbers (run-metrics.ts), rendered as the closing "Efficiency" section. */
  readonly metrics: RunMetrics;
  /**
   * The colleague review (stages/narrate.ts). With markdown, it becomes the
   * top of the comment and the report collapses below it; without (failed
   * or skipped), its `note` heads the plain report. Absent/`null` when no
   * narrator ran and there is nothing to say: the plain report, unchanged.
   */
  readonly narrative?: NarrateStageResult | null;
  /** `reviewer.language`, for the narrative's heading. Default: English. */
  readonly language?: string;
}

const AUTO_MERGE_OK_LABEL = "jevest:auto-merge-ok";
const NEEDS_HUMAN_LABEL = "jevest:needs-human";
const SPEND_WARNING_LABEL = "jevest:spend-warning";
const SPEND_CAP_REACHED_LABEL = "jevest:spend-cap-reached";
const DESCRIPTION_MISMATCH_LABEL = "jevest:description-mismatch";
const NEEDS_PRODUCT_OWNER_LABEL = "jevest:needs-product-owner";
const INJECTED_INSTRUCTIONS_LABEL = "jevest:injected-instructions";

function usd(value: number): string {
  return value.toFixed(2);
}

/** The hunk profile's in-diff verdict reached the "yes" bar (same bar the merge gate fails on). */
function injectedInDiff(hunkProfile: HunkProfileStageResult): boolean {
  return (
    hunkProfile.injectedInstructionsInDiff.maxProb >= INJECTED_INSTRUCTIONS_IN_DIFF_YES_MIN_PROB
  );
}

function injectedInstructionsLine(
  triage: TriageStageResult,
  hunkProfile: HunkProfileStageResult,
): string {
  const { maxProb, hunkIds } = hunkProfile.injectedInstructionsInDiff;
  const hunks = hunkIds.length === 0 ? "none" : hunkIds.join(", ");
  return `- Injected instructions: in description P=${triage.containsInjectedInstructionsProb} · in diff P=${maxProb} (hunks: ${hunks})`;
}

function injectedInstructionsQueueLine(hunkProfile: HunkProfileStageResult): string {
  const { maxProb, hunkIds } = hunkProfile.injectedInstructionsInDiff;
  const hunks = hunkIds.map((id) => `\`${id}\``).join(", ");
  return `- The diff contains instructions addressed to a reviewer or an AI (P = ${maxProb}) in ${hunks}: a human should read those hunks before trusting any review of them.`;
}

function applyInjectedInstructionsLabel(
  hunkProfile: HunkProfileStageResult,
  labelsToAdd: string[],
  labelsToRemove: string[],
): void {
  if (injectedInDiff(hunkProfile)) {
    labelsToAdd.push(INJECTED_INSTRUCTIONS_LABEL);
  } else {
    labelsToRemove.push(INJECTED_INSTRUCTIONS_LABEL);
  }
}

/** A mismatch the policy lets us act on (auto) or ask about (confirm); escalate-band evidence is reported only. */
function mismatchIsActionable(triage: TriageStageResult): boolean {
  return (
    triage.descriptionMismatch &&
    (triage.descriptionMismatchBand === "auto" || triage.descriptionMismatchBand === "confirm")
  );
}

function mismatchForcesNeutral(triage: TriageStageResult): boolean {
  return triage.descriptionMismatch && triage.descriptionMismatchBand === "auto";
}

function mismatchQueueLine(triage: TriageStageResult): string {
  return `- The PR description does not match the change (P(matches_intent) = ${triage.matchesIntentProb}, ${triage.descriptionMismatchBand} band): a human should compare the description with the diff.`;
}

function buildIntentVsChangeSection(triage: TriageStageResult): string[] {
  const summary = triage.changeSummary;
  const summaryLines: string[] = [];
  if (summary !== null) {
    summaryLines.push(
      `- What changes (per the diff summary by ${triage.summaryModel ?? "the summarizer"}, written without seeing the description): ${summary.whatChanges}`,
    );
    for (const behavior of summary.behaviorChanges) {
      summaryLines.push(`  - ${behavior}`);
    }
    summaryLines.push(
      `- User-facing per the summary: ${summary.userFacing ? "yes" : "no"}; breaking: ${summary.breaking ? "yes" : "no"}`,
    );
    for (const risk of summary.risks) {
      summaryLines.push(`  - risk: ${risk}`);
    }
  } else if (triage.summaryError !== null) {
    summaryLines.push(
      `- No change summary: the summarizer failed (${describeReviewerError(triage.summaryError)}). Triage ran on file facts only, without the summary.`,
    );
  } else {
    summaryLines.push(
      "- No change summary was requested (triage.changeSummary is never, or no LLM reviewer is configured). Triage ran on file facts only.",
    );
  }

  const context = triage.productContext;
  const areaLines: string[] = [];
  if (context.areas.length === 0) {
    areaLines.push(
      context.productName === null
        ? "- Product areas touched: none (no product context file, or no area matched)."
        : `- Product areas touched (${context.productName}): none of the configured areas matched.`,
    );
  } else {
    areaLines.push(
      `- Product areas touched${context.productName === null ? "" : ` (${context.productName})`}:`,
    );
    for (const area of context.areas) {
      const owners = area.owners.length > 0 ? `, owners: ${area.owners.join(", ")}` : "";
      areaLines.push(`  - ${area.name} (criticality ${area.criticality}${owners})`);
      for (const rule of area.rules) {
        areaLines.push(`    - rule: ${rule}`);
      }
    }
    if (triage.riskLevel !== triage.jevRiskLevel) {
      areaLines.push(
        `- Risk raised from ${triage.jevRiskLevel} to ${triage.riskLevel} by the highest area criticality.`,
      );
    }
  }

  const verdict = triage.descriptionMismatch
    ? `no (mismatch, ${triage.descriptionMismatchBand} band)`
    : triage.descriptionMatchesChange;
  return [
    "### Intent vs change",
    ...summaryLines,
    ...areaLines,
    `- Description matches the change: ${verdict} (P(matches_intent) = ${triage.matchesIntentProb})`,
    `- Needs a product owner: ${triage.needsProductOwnerLabel ? "yes" : "no"} (P = ${triage.needsProductOwnerProb})`,
    "",
  ];
}

function applyTriageV2Labels(
  triage: TriageStageResult,
  labelsToAdd: string[],
  labelsToRemove: string[],
): void {
  if (mismatchIsActionable(triage)) {
    labelsToAdd.push(DESCRIPTION_MISMATCH_LABEL);
  } else {
    labelsToRemove.push(DESCRIPTION_MISMATCH_LABEL);
  }
  if (triage.needsProductOwnerLabel) {
    labelsToAdd.push(NEEDS_PRODUCT_OWNER_LABEL);
  } else {
    labelsToRemove.push(NEEDS_PRODUCT_OWNER_LABEL);
  }
}

function periodWording(evaluation: SpendCapEvaluation): string {
  return evaluation.period === "total" ? "in total" : `this ${evaluation.period}`;
}

function buildSpendCapSection(input: PublishStageInput): string[] {
  const { spendCap, spendLedgerError } = input;
  if (!spendCap && !spendLedgerError) {
    return [];
  }
  return [
    "### Spend cap",
    ...(spendLedgerError
      ? [
          `- spend ledger unavailable: ${spendLedgerError} — cumulative cap not enforced on this run.`,
        ]
      : []),
    ...(spendCap
      ? [
          `- USD ${usd(spendCap.spentUsd)} of ${usd(spendCap.capUsd)} ${periodWording(spendCap)} (${usd(spendCap.remainingUsd)} left)`,
          `- Status: ${spendCap.status}${spendCap.status === "reached" ? " — the LLM review stage is skipped until the cap resets or is raised" : ""}`,
        ]
      : []),
    "",
  ];
}

function spendCapCheckLine(spendCap: SpendCapEvaluation | null | undefined): string {
  if (!spendCap || spendCap.status === "ok") {
    return "";
  }
  return ` Spend cap ${spendCap.status}: USD ${usd(spendCap.spentUsd)} of ${usd(spendCap.capUsd)} (${spendCap.periodKey}).`;
}

function applySpendCapLabels(
  spendCap: SpendCapEvaluation | null | undefined,
  labelsToAdd: string[],
  labelsToRemove: string[],
): void {
  if (!spendCap) {
    return;
  }
  switch (spendCap.status) {
    case "reached":
      labelsToAdd.push(SPEND_CAP_REACHED_LABEL);
      labelsToRemove.push(SPEND_WARNING_LABEL);
      return;
    case "warning":
      labelsToAdd.push(SPEND_WARNING_LABEL);
      labelsToRemove.push(SPEND_CAP_REACHED_LABEL);
      return;
    case "ok":
      labelsToRemove.push(SPEND_WARNING_LABEL, SPEND_CAP_REACHED_LABEL);
      return;
  }
}

function sha256(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function buildInlineComments(
  findingFilter: FindingFilterStageResult,
  hunksById: ReadonlyMap<string, HunkProfileEntry>,
): InlineComment[] {
  return findingFilter.published.map((finding) => {
    // finding.lineStart is a BEFORE-side line (ReviewFindingCandidate's own
    // contract); InlineComment.line must be a HEAD-side line (VcsPort's
    // contract) — map through the owning hunk's diff.
    const hunk = hunksById.get(finding.hunkId);
    const line = hunk ? mapBeforeLineToAfterLine(hunk, finding.lineStart) : finding.lineStart;
    const body = `**${finding.claim}**\n\n${finding.rationale}`;
    return {
      path: finding.file,
      line,
      body,
      fingerprint: sha256(finding.file, String(line), finding.claim),
    };
  });
}

function buildSkippedHunksSection(hunkProfile: HunkProfileStageResult): string {
  const skipped = hunkProfile.hunks.filter((h) => h.skippedFromReview);
  if (skipped.length === 0) {
    return "No hunks were skipped.";
  }
  const lines = skipped.map((h) => {
    if (h.containsSecret) {
      return `- \`${h.file}\` (${h.hunkHeader}): skipped — hunk contains a redacted secret.`;
    }
    return `- \`${h.file}\` (${h.hunkHeader}): skipped — change_kind=\`${h.changeKind}\` at confidence ${h.changeKindConfidence}.`;
  });
  return lines.join("\n");
}

function buildNeedsHumanSection(
  findingFilter: FindingFilterStageResult,
  triage: TriageStageResult,
  hunkProfile: HunkProfileStageResult,
  review: ReviewStageResult,
): string {
  const lines = findingFilter.needsHuman.map((f) => {
    const suffix = f.unverified ? " — unverified (Jev unavailable)" : "";
    return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})${suffix}`;
  });
  if (mismatchIsActionable(triage)) {
    lines.push(mismatchQueueLine(triage));
  }
  if (injectedInDiff(hunkProfile)) {
    lines.push(injectedInstructionsQueueLine(hunkProfile));
  }
  if (allReviewsFailed(review)) {
    lines.push(`- ${NO_HUNK_REVIEWED} A human should review this pull request directly.`);
  }
  if (lines.length === 0) {
    return "No findings need human review.";
  }
  return lines.join("\n");
}

/**
 * `mode: "annotate"` (H1 pending, product decision 2026-09-22, see
 * stages/finding-filter.ts): findings that would have been discarded are
 * kept visible here instead — in a collapsed section so they don't compete
 * with the findings a human actually needs to look at, never as inline
 * comments, and part of the fingerprinted content (unlike Efficiency)
 * because they are review content, not timing. Always empty in
 * `mode: "discard"`, rendered the same way as any other empty bucket.
 */
function buildLowConfidenceSection(findingFilter: FindingFilterStageResult): string[] {
  const body =
    findingFilter.lowConfidence.length === 0
      ? ["No low-confidence findings."]
      : findingFilter.lowConfidence.map((f) => {
          const confidence = noulConfidence(f.isRealDefectProb);
          // `isRealDefectProb` is the CALIBRATED probability when
          // `findingFilter.calibration` is on (SPEC §4.6.3) — the number that
          // actually banded this finding, so it is the one shown. Jev's raw
          // answer follows only when a map moved it, because a reader
          // comparing this comment with a Jev fixture needs to see both.
          const raw =
            f.rawIsRealDefectProb === f.isRealDefectProb ? "" : `, raw=${f.rawIsRealDefectProb}`;
          return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (P(real defect)=${f.isRealDefectProb}${raw}, confidence=${confidence})`;
        });
  return [
    "<details>",
    "<summary>Low-confidence findings (annotated, not filtered — H1 pending)</summary>",
    "",
    ...body,
    "",
    "</details>",
  ];
}

/** Files listed per distinct error before "+N more". */
const MAX_FILES_PER_ERROR = 6;

const AUTH_FAILURE_HINT =
  "The reviewer could not authenticate: the provider credential (for claude-cli, the `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token`; otherwise the provider's API key secret) is invalid or expired. Renew it and re-run the job.";

/**
 * No hunk was reviewed: the reviewer was called at least once and threw on
 * every call. NFR-2 fail closed: such a run never reaches auto-merge-ok
 * (see {@link resolvePublishConclusion}). Zero attempts (Jev-only mode, a
 * reached spend cap, nothing eligible) is not a failure.
 */
export function allReviewsFailed(review: ReviewStageResult): boolean {
  return review.reviews.length > 0 && review.reviews.every((r) => r.error !== null);
}

function failedReviews(review: ReviewStageResult): ReviewStageEntry[] {
  return review.reviews.filter((r) => r.error !== null);
}

function describeFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_PER_ERROR).map((f) => `\`${f}\``);
  const more =
    files.length > MAX_FILES_PER_ERROR ? ` +${files.length - MAX_FILES_PER_ERROR} more` : "";
  return `${files.length} ${files.length === 1 ? "file" : "files"}: ${shown.join(", ")}${more}`;
}

/** Empty when every reviewer call returned; see the module doc. */
function buildReviewFailedSection(review: ReviewStageResult): string[] {
  const failed = failedReviews(review);
  if (failed.length === 0) {
    return [];
  }
  const filesByError = new Map<string, Set<string>>();
  for (const entry of failed) {
    const message = describeReviewerError(entry.error ?? "");
    const files = filesByError.get(message) ?? new Set<string>();
    files.add(entry.file);
    filesByError.set(message, files);
  }
  return [
    "### ⚠️ LLM review failed",
    `The reviewer failed on ${failed.length} of ${review.reviews.length} hunks — these hunks were NOT reviewed, so 'no findings' below does not mean the code is clean.`,
    ...[...filesByError].map(([message, files]) => `- ${message} — ${describeFiles([...files])}`),
    ...([...filesByError.keys()].some(isAuthenticationFailure) ? [AUTH_FAILURE_HINT] : []),
    "",
  ];
}

const NO_HUNK_REVIEWED = "No hunk was reviewed: the reviewer failed on every hunk it was given.";

function buildHighConfidenceFindingsSection(
  findingFilter: FindingFilterStageResult,
  review: ReviewStageResult,
): string {
  if (findingFilter.published.length === 0) {
    return allReviewsFailed(review) ? NO_HUNK_REVIEWED : "No high-confidence findings.";
  }
  return findingFilter.published
    .map((f) => `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})`)
    .join("\n");
}

function buildCostSection(input: PublishStageInput): string {
  const jevUsage = [
    input.triage.usage,
    input.hunkProfile.totalUsage,
    input.findingFilter.totalUsage,
    input.mergeGate.usage,
  ].reduce(
    (acc, usage) => ({
      inputTokens: acc.inputTokens + usage.inputTokens,
      outputTokens: acc.outputTokens + usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  return [
    `- LLM review cost: $${input.review.totalCostUsd.toFixed(4)}`,
    summaryCostLine(input.triage),
    `- Jev decision usage: ${jevUsage.inputTokens} input tokens, ${jevUsage.outputTokens} output tokens`,
  ].join("\n");
}

function summaryCostLine(triage: TriageStageResult): string {
  return `- Change summary cost: $${triage.summaryCostUsd.toFixed(4)}`;
}

const SKIP_REASON_WORDS: readonly [Exclude<keyof LlmSkippedHunks, "total">, string][] = [
  ["triageSkip", "triage skip"],
  ["skipChangeKind", "change kind"],
  ["secret", "secret"],
  ["budget", "budget"],
  ["spendCap", "spend cap"],
  ["reviewerDisabled", "reviewer disabled"],
];

function skippedByReason(skipped: LlmSkippedHunks): string {
  const parts = SKIP_REASON_WORDS.filter(([key]) => skipped[key] > 0).map(
    ([key, word]) => `${word} ${skipped[key]}`,
  );
  return parts.length === 0
    ? `${skipped.total} skipped`
    : `${skipped.total} skipped (${parts.join(", ")})`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The narrative's own numbers. Outside the H2 token counts on purpose: the
 * "without Jev" counterfactual prices reviewing every hunk, and the
 * narrative is a per-PR call that exists with or without Jev.
 */
function narrativeEfficiencyLine(narrative: NarrateStageResult): string {
  const usage = narrative.usage;
  const tokens = usage
    ? usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens +
      usage.outputTokens
    : 0;
  return `- Review narrative: ${tokens} tokens · $${narrative.costUsd.toFixed(4)} (${narrative.model ?? "unknown model"})`;
}

/** The closing section; see the module doc for why it is last and outside the fingerprint. */
function buildEfficiencySection(metrics: RunMetrics, narrative?: NarrateStageResult): string[] {
  const { jev, llm } = metrics;
  return [
    "### Efficiency",
    `- Jev: ${plural(jev.requests.total, "request")} · p95 latency ${jev.latency.p95Ms} ms · total Jev time ${jev.latency.sumMs} ms`,
    `- LLM: ${llm.hunks.reviewed} of ${llm.hunks.total} hunks reviewed${llm.hunks.failed > 0 ? ` · ${llm.hunks.failed} failed (reviewer error)` : ""} · ${skippedByReason(llm.hunks.skipped)}`,
    `- LLM tokens: ${llm.tokens.spent} tokens spent (review ${llm.tokens.reviewInput + llm.tokens.reviewOutput}, summary ${llm.tokens.summaryInput + llm.tokens.summaryOutput}) · without Jev ≈ ${llm.tokensWithoutJev} · saved ≈ ${llm.tokensSavedPct}%`,
    ...(narrative ? [narrativeEfficiencyLine(narrative)] : []),
    `- ${llm.method}`,
  ];
}

/** Joins the stable content and the efficiency section, fingerprinting only the former. */
function withEfficiency(
  stableLines: readonly string[],
  metrics: RunMetrics,
): { summaryMarkdown: string; summaryFingerprint: string } {
  const stable = stableLines.join("\n");
  return {
    summaryMarkdown: [stable, "", ...buildEfficiencySection(metrics)].join("\n"),
    summaryFingerprint: sha256(stable),
  };
}

/** `## Review` in `reviewer.language`; the language tag's primary subtag decides ("es-AR" is "es"). */
const REVIEW_HEADINGS: Readonly<Record<string, string>> = {
  es: "Revisión",
  en: "Review",
  pt: "Revisão",
  fr: "Revue",
  it: "Revisione",
  de: "Review",
};

function reviewHeading(language: string | undefined): string {
  const primary = (language ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return `## ${REVIEW_HEADINGS[primary] ?? "Review"}`;
}

/**
 * The summary comment around the deterministic report (see the module doc,
 * "Colleague review"). The fingerprint is ALWAYS `sha256` of the plain
 * report's stable lines — the same bytes as a run without a narrator — so
 * neither the narrative's wording, its cost, the fallback note nor the
 * layout can change it. The GitHub adapter updates the single summary
 * comment in place whatever the fingerprint says, so a new wording still
 * reaches the PR; it just never counts as new review content (NFR-12).
 */
function renderSummary(
  parts: SummaryParts,
  input: PublishStageInput,
): { summaryMarkdown: string; summaryFingerprint: string } {
  const plain = withEfficiency(stableSummaryLines(parts), input.metrics);
  const narrative = input.narrative;
  if (!narrative || narrative.markdown === null) {
    return narrative?.note
      ? { ...plain, summaryMarkdown: `> ${narrative.note}\n\n${plain.summaryMarkdown}` }
      : plain;
  }
  const summaryMarkdown = [
    reviewHeading(input.language),
    "",
    narrative.markdown,
    "",
    // Never collapsed: "the reviewer failed" must not hide behind a click.
    ...parts.warning,
    "<details>",
    "<summary>Jevest details</summary>",
    "",
    ...parts.head,
    ...parts.body,
    "",
    ...buildEfficiencySection(input.metrics, narrative),
    "",
    "</details>",
  ].join("\n");
  return { summaryMarkdown, summaryFingerprint: plain.summaryFingerprint };
}

/**
 * The report in three parts, so the narrative layout can keep `warning`
 * visible while collapsing the rest; {@link stableSummaryLines} joins them
 * back into exactly the plain report.
 */
interface SummaryParts {
  /** The spend-cap banner, when the cap turned this into a Jev-only run. */
  readonly head: string[];
  /** The "LLM review failed" section; empty when every reviewer call returned. */
  readonly warning: string[];
  readonly body: string[];
}

function stableSummaryLines(parts: SummaryParts): string[] {
  return ["## Jevest review", "", ...parts.head, ...parts.warning, ...parts.body];
}

function buildSummaryParts(input: PublishStageInput): SummaryParts {
  const skippedForSpendCap = input.reviewSkippedForSpendCap === true;
  const spendCapBanner =
    skippedForSpendCap && input.spendCap
      ? `**LLM review skipped: spend cap reached** — USD ${usd(input.spendCap.spentUsd)} of ${usd(input.spendCap.capUsd)} ${periodWording(input.spendCap)}. Jev-only run; raise \`spendCap.usd\` or reset the ledger to resume LLM reviews.`
      : "**LLM review skipped: spend cap reached** — Jev-only run.";

  return {
    head: skippedForSpendCap ? [spendCapBanner, ""] : [],
    warning: buildReviewFailedSection(input.review),
    body: buildReportBody(input),
  };
}

function buildReportBody(input: PublishStageInput): string[] {
  const { triage, findingFilter, mergeGate } = input;
  return [
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    `- LLM review skipped: ${triage.skipLlmReview}`,
    `- Needs human: ${triage.needsHumanLabel}`,
    injectedInstructionsLine(triage, input.hunkProfile),
    "",
    ...buildIntentVsChangeSection(triage),
    ...(input.reviewDisabled
      ? ["", "**LLM review disabled by config** (reviewer.provider: none — Jev-only mode)."]
      : []),
    "",
    ...buildSpendCapSection(input),
    "### Skipped hunks",
    buildSkippedHunksSection(input.hunkProfile),
    "",
    ...(input.inlineCommentsEnabled
      ? []
      : [
          "### Findings (high confidence)",
          buildHighConfidenceFindingsSection(findingFilter, input.review),
          "",
        ]),
    "### Needs human review",
    buildNeedsHumanSection(findingFilter, triage, input.hunkProfile, input.review),
    "",
    `### Findings discarded: ${findingFilter.discarded.length}`,
    "",
    ...buildLowConfidenceSection(findingFilter),
    "",
    "### Cost breakdown",
    buildCostSection(input),
    "",
    "### Merge gate",
    `- Safe to automerge probability: ${mergeGate.safeToAutomergeProb}`,
    `- Conclusion: ${mergeGate.conclusion}`,
  ];
}

/**
 * FR-2.3: when triage decides the LLM review can be skipped (low risk,
 * high confidence, no suspected injection), the pipeline never runs
 * hunk-profile/review/finding-filter/merge-gate — it publishes only the
 * triage label and a short summary, per the spec's literal wording ("se
 * publica solo label y resumen de triage").
 */
export function runTriageOnlyPublishStage(
  triage: TriageStageResult,
  metrics: RunMetrics,
): ReviewPublication {
  const forcedNeutral = mismatchForcesNeutral(triage);
  const summaryLines = [
    "## Jevest review",
    "",
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    "- LLM review skipped (FR-2.3): low risk, high confidence, no suspected instruction injection.",
    `- Needs human: ${triage.needsHumanLabel}`,
    "",
    ...buildIntentVsChangeSection(triage),
    ...(mismatchIsActionable(triage)
      ? ["### Needs human review", mismatchQueueLine(triage), ""]
      : []),
    "### Cost breakdown",
    summaryCostLine(triage),
  ];

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [AUTO_MERGE_OK_LABEL];
  if (triage.needsHumanLabel) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }
  applyTriageV2Labels(triage, labelsToAdd, labelsToRemove);

  return {
    ...withEfficiency(summaryLines, metrics),
    inlineComments: [],
    labelsToAdd,
    labelsToRemove,
    check: {
      conclusion: forcedNeutral ? "neutral" : "success",
      title: forcedNeutral ? "Jevest: description mismatch" : "Jevest: skipped (low risk)",
      summary: `Triage: ${triage.category}/${triage.riskLevel}. LLM review skipped per FR-2.3.${forcedNeutral ? " The PR description does not match the change; a human should look." : ""}`,
    },
  };
}

/**
 * NFR-2: "Siempre falla cerrado" — when Jev fails to respond at any stage,
 * the whole pipeline stops there rather than guessing with a broken
 * foundation (re-attempting a down Jev at every remaining stage burns
 * budget without evidence it will recover). No inline comments are
 * published, nothing is marked safe to merge, and a human is asked to
 * look directly at the pull request.
 */
export function buildFailClosedPublication(
  failedStage: string,
  lastKnownTriage: TriageStageResult | null,
  /** Replaces the "Jev did not respond" line when the failing step was not a Jev call (e.g. an invalid product context file). */
  detail?: string,
): ReviewPublication {
  const summaryMarkdown = [
    "## Jevest review",
    "",
    "### Pipeline failed closed (NFR-2)",
    detail ?? `Jev did not respond during the **${failedStage}** stage.`,
    "- No findings were published inline.",
    "- Nothing is marked safe to auto-merge.",
    "- A human should review this pull request directly.",
    ...(lastKnownTriage
      ? [
          "",
          `Last known triage: category=${lastKnownTriage.category}, risk=${lastKnownTriage.riskLevel}.`,
        ]
      : []),
  ].join("\n");

  return {
    summaryMarkdown,
    summaryFingerprint: sha256(summaryMarkdown),
    inlineComments: [],
    labelsToAdd: [NEEDS_HUMAN_LABEL],
    labelsToRemove: [AUTO_MERGE_OK_LABEL],
    check: {
      conclusion: "failure",
      title: "Jevest: failed closed",
      summary: detail
        ? `${failedStage} failed — failing closed per NFR-2: ${detail}`
        : `Jev unavailable during ${failedStage} — failing closed per NFR-2.`,
    },
  };
}

export interface PublishConclusion {
  readonly conclusion: MergeGateStageResult["conclusion"];
  /** An auto-band description mismatch downgraded a green gate. */
  readonly forcedNeutralForMismatch: boolean;
  /** Every attempted reviewer call failed (NFR-2): the check is at most neutral. */
  readonly reviewFailedEntirely: boolean;
}

/**
 * The check conclusion the publication will carry, from the merge gate
 * plus the two code-level downgrades. Exported so the review narrator can
 * be told the same verdict the check shows. Both downgrades only ever turn
 * green into neutral: they never override a neutral or red gate, and
 * never turn anything red by themselves.
 */
export function resolvePublishConclusion(
  input: Pick<PublishStageInput, "triage" | "review" | "mergeGate">,
): PublishConclusion {
  const green = input.mergeGate.conclusion === "success";
  // A human must compare the story with the diff.
  const forcedNeutralForMismatch = green && mismatchForcesNeutral(input.triage);
  // Zero findings from a reviewer that never answered reads like a clean
  // review to Jev's gate; it is not one, so a human decides.
  const reviewFailedEntirely = allReviewsFailed(input.review);
  const conclusion =
    green && (forcedNeutralForMismatch || reviewFailedEntirely)
      ? "neutral"
      : input.mergeGate.conclusion;
  return { conclusion, forcedNeutralForMismatch, reviewFailedEntirely };
}

export function runPublishStage(input: PublishStageInput): ReviewPublication {
  const summary = renderSummary(buildSummaryParts(input), input);
  const hunksById = new Map(input.hunkProfile.hunks.map((h) => [h.id, h]));
  const inlineComments = input.inlineCommentsEnabled
    ? buildInlineComments(input.findingFilter, hunksById)
    : [];

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [];

  const {
    conclusion,
    forcedNeutralForMismatch: forcedNeutral,
    reviewFailedEntirely,
  } = resolvePublishConclusion(input);

  if (conclusion === "success") {
    labelsToAdd.push(AUTO_MERGE_OK_LABEL);
  } else {
    labelsToRemove.push(AUTO_MERGE_OK_LABEL);
  }

  if (input.triage.needsHumanLabel || reviewFailedEntirely) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }
  applyTriageV2Labels(input.triage, labelsToAdd, labelsToRemove);
  applyInjectedInstructionsLabel(input.hunkProfile, labelsToAdd, labelsToRemove);
  applySpendCapLabels(input.spendCap, labelsToAdd, labelsToRemove);

  const mismatchCheckLine = forcedNeutral
    ? " The PR description does not match the change; a human should look."
    : "";

  const failedCount = failedReviews(input.review).length;
  const reviewFailedTitle = failedCount > 0 ? " (LLM review failed)" : "";
  const reviewFailedCheckLine =
    failedCount > 0
      ? ` LLM review failed on ${failedCount} of ${input.review.reviews.length} hunk(s); those were not reviewed.${reviewFailedEntirely ? " Nothing is marked safe to auto-merge." : ""}`
      : "";

  return {
    ...summary,
    inlineComments,
    labelsToAdd,
    labelsToRemove,
    check: {
      conclusion,
      title: `Jevest: ${conclusion}${reviewFailedTitle}`,
      summary: `Triage: ${input.triage.category}/${input.triage.riskLevel}. Published ${input.findingFilter.published.length} finding(s), ${input.findingFilter.needsHuman.length} need human review.${reviewFailedCheckLine}${mismatchCheckLine}${spendCapCheckLine(input.spendCap)}`,
    },
  };
}
