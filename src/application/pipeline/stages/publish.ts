/**
 * Stage 6: publish (SPEC FR-7). Pure data transform — no ports, no I/O — so
 * it stays synchronous, unlike the other stages. Builds the VcsPort-shaped
 * `ReviewPublication` from every prior stage's result: inline comments only
 * for auto-band findings (`findingFilter.published`); a markdown summary
 * covering the triage decision, skipped hunks, the questions and manual
 * checks, discarded count, low-confidence findings and cost breakdown; and
 * the labels/check for the run's review verdict. Fingerprints are `sha256` of
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
 * mismatch in the AUTO band is a question for the author (verdict
 * `questions`, neutral) and lists the PR in the human queue. It never
 * turns a check red on its own.
 *
 * In-diff injection (NFR-7): the Triage section reports both injection
 * probabilities (triage's, over the description; the hunk profile's, over
 * the diff) and the flagged hunks; at or above the hunk profile's "yes"
 * bar the PR gets `jevest:injected-instructions` and a human-queue line
 * naming the hunks. The verdict is `unavailable` (neutral) unless findings
 * were published: the review may have been steered. The merge gate already
 * failed in code on the same signal, so auto-merge-ok is never applied.
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
 * identical clean one). A partial failure leaves the verdict to the counts.
 * When EVERY attempted call failed, NFR-2 fails closed in code: the verdict
 * is `unavailable` (neutral), auto-merge-ok is never applied and the PR
 * gets the review-manually label plus a line in the human queue — Jev's
 * gate only saw "zero findings", which is not a review.
 *
 * Possible secrets (NFR-3): a hunk where the redactor found a secret was
 * reviewed with the value redacted (hunk-profile.ts), never skipped. It
 * gets one visible "possible committed secret" line near the top of the
 * comment in `reviewer.language` (es by default, en otherwise; outside the
 * collapsed block with a narrative), a line in "Questions and manual
 * checks" and in the check summary, and counts as one question, so the
 * verdict is at least `questions`. The warning IS fingerprinted.
 *
 * Review verdict (src/domain/review-verdict.ts): ONE action per run — fix,
 * questions, clear or unavailable — decides the check conclusion
 * (failure / neutral / success / neutral), its title and summary in
 * `reviewer.language`, and exactly one verdict label (the other three and
 * the legacy `jevest:needs-human` are removed on every run). The merge
 * gate no longer colors the check: it only decides `jevest:auto-merge-ok`,
 * which also needs a `clear` verdict. A risk label (`risk: high` /
 * `risk: medium`, localized) mirrors triage's risk level.
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
 *
 * Author context (stages/description-context.ts): what the reviewer was
 * given from the PR description is listed in an "Author context used by
 * the reviewer" section — inside the collapsed block with a narrative, at
 * the end of the plain report without one, always right before
 * "Efficiency" — together with a "Discarded from the description" list of
 * what was dropped for steering the review, or the one-line note saying
 * why the description was not used. When anything was discarded, one
 * short line in `reviewer.language` (es by default, en otherwise) is
 * VISIBLE above the collapsed block (above the plain report without a
 * narrative): a steering attempt is a signal for the human reviewer. None
 * of it is fingerprinted: it is LLM output, like the narrative, and an
 * extractor rewording the same description must not look like new review
 * content (NFR-12). Its cost is in "Efficiency", next to the narrative's.
 */
import { createHash } from "node:crypto";
import { AUTHOR_CONTEXT_HEADINGS, AUTHOR_CONTEXT_KINDS } from "../../../domain/author-context.js";
import { mapBeforeLineToAfterLine } from "../../../domain/hunk-splitter.js";
import type {
  InlineComment,
  LabelDefinition,
  ReviewPublication,
} from "../../../domain/ports/vcs-port.js";
import {
  type LlmReviewOutcome,
  type ReviewVerdictResult,
  decideReviewVerdict,
  verdictConclusion,
  verdictLabelChanges,
  verdictLanguage,
  verdictSummary,
  verdictTitle,
} from "../../../domain/review-verdict.js";
import { describeReviewerError, isAuthenticationFailure } from "../../../domain/reviewer-error.js";
import type { SpendCapEvaluation } from "../../../domain/spend-cap.js";
import type { LlmSkippedHunks, RunMetrics } from "../run-metrics.js";
import type { DescriptionContextStageResult } from "./description-context.js";
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
  /**
   * `reviewer.language`: the narrative's heading (default English) and the
   * verdict's check title, summary and labels (es by default, en for any
   * other language; see review-verdict.ts).
   */
  readonly language?: string;
  /**
   * Triage's `contains_injected_instructions` at or above its confirm bar
   * (resolved by the pipeline, the same flag the merge gate fails on).
   * Makes the verdict `unavailable` unless findings were published.
   */
  readonly injectedInstructionsInDescription?: boolean;
  /**
   * What the reviewer got from the PR description (stages/description-context.ts);
   * absent/`null` when the extractor was not configured or not applicable,
   * and then nothing is rendered. See the module doc, "Author context".
   */
  readonly descriptionContext?: DescriptionContextStageResult | null;
}

const AUTO_MERGE_OK_LABEL = "jevest:auto-merge-ok";
const MISMATCH_CHECK_LINE = " The PR description does not match the change; a human should look.";
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
  return findingFilter.published.flatMap((finding): InlineComment[] => {
    const body = `**${finding.claim}**\n\n${finding.rationale}`;
    if (finding.agentic) {
      // Agentic mode: the judge already resolved a HEAD-side line of the
      // diff (or none: such a finding is listed in the summary instead,
      // since a comment off the diff would be refused by the VCS).
      const anchor = finding.agentic.inlineAnchor;
      if (anchor === null) return [];
      return [
        {
          path: anchor.path,
          line: anchor.line,
          body,
          fingerprint: sha256(anchor.path, String(anchor.line), finding.claim),
        },
      ];
    }
    // finding.lineStart is a BEFORE-side line (ReviewFindingCandidate's own
    // contract); InlineComment.line must be a HEAD-side line (VcsPort's
    // contract) — map through the owning hunk's diff.
    const hunk = hunksById.get(finding.hunkId);
    const line = hunk ? mapBeforeLineToAfterLine(hunk, finding.lineStart) : finding.lineStart;
    return [
      {
        path: finding.file,
        line,
        body,
        fingerprint: sha256(finding.file, String(line), finding.claim),
      },
    ];
  });
}

function buildSkippedHunksSection(hunkProfile: HunkProfileStageResult): string {
  const skipped = hunkProfile.hunks.filter((h) => h.skippedFromReview);
  if (skipped.length === 0) {
    return "No hunks were skipped.";
  }
  const lines = skipped.map(
    (h) =>
      `- \`${h.file}\` (${h.hunkHeader}): skipped — change_kind=\`${h.changeKind}\` at confidence ${h.changeKindConfidence}.`,
  );
  return lines.join("\n");
}

function secretHunks(hunkProfile: HunkProfileStageResult): HunkProfileEntry[] {
  return hunkProfile.hunks.filter((h) => h.containsSecret);
}

/**
 * The visible "possible committed secret" warning (NFR-3), one line per
 * flagged hunk in `reviewer.language` (es by default, en otherwise). The
 * hunk was reviewed with the value redacted; the author still has to check
 * whether a real credential reached the repository.
 */
function buildSecretWarnings(
  hunkProfile: HunkProfileStageResult,
  language: string | undefined,
): string[] {
  const hunks = secretHunks(hunkProfile);
  if (hunks.length === 0) {
    return [];
  }
  const es = verdictLanguage(language) === "es";
  const lines = hunks.map((h) => {
    const where = `\`${h.file}\` (\`${inlineSafe(h.hunkHeader)}\`)`;
    return es
      ? `> ⚠️ **Posible secreto commiteado** en ${where}: revisá y rotalo si es real.`
      : `> ⚠️ **Possible committed secret** in ${where}: check it and rotate it if it is real.`;
  });
  return [lines.join("\n>\n"), ""];
}

function buildNeedsHumanSection(
  findingFilter: FindingFilterStageResult,
  triage: TriageStageResult,
  hunkProfile: HunkProfileStageResult,
  review: ReviewStageResult,
): string {
  const lines = findingFilter.needsHuman.map((f) => {
    const suffix = f.unverified
      ? " — unverified (Jev unavailable)"
      : f.agentic
        ? ` — question: ${f.agentic.route}`
        : "";
    return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})${suffix}`;
  });
  if (mismatchIsActionable(triage)) {
    lines.push(mismatchQueueLine(triage));
  }
  if (injectedInDiff(hunkProfile)) {
    lines.push(injectedInstructionsQueueLine(hunkProfile));
  }
  for (const h of secretHunks(hunkProfile)) {
    lines.push(
      `- Possible committed secret in \`${h.file}\` (\`${inlineSafe(h.hunkHeader)}\`), redacted before any external call: the author should check it and rotate it if it is real.`,
    );
  }
  if (allReviewsFailed(review)) {
    lines.push(`- ${NO_HUNK_REVIEWED} A human should review this pull request directly.`);
  }
  if (lines.length === 0) {
    return "Nothing to answer or check by hand.";
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
          if (f.rejectedReason !== undefined) {
            return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (not published: ${f.rejectedReason})`;
          }
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
 * (see {@link resolvePublishVerdict}). Zero attempts (Jev-only mode, a
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

/**
 * Agentic mode: published findings with no line of the diff to comment on
 * (a caller broken elsewhere). An inline comment there would be refused,
 * so they are listed here. Empty (nothing rendered) otherwise, and always
 * in the per-hunk mode.
 */
function buildOutsideDiffSection(findingFilter: FindingFilterStageResult): string[] {
  const outside = findingFilter.published.filter(
    (f) => f.agentic && f.agentic.inlineAnchor === null,
  );
  if (outside.length === 0) return [];
  return [
    "### Findings outside the diff",
    ...outside.map((f) => `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})`),
    "",
  ];
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

/** The extractor's own numbers, next to the narrative's and for the same reason. */
function descriptionContextEfficiencyLine(context: DescriptionContextStageResult): string {
  const usage = context.usage;
  const tokens = usage
    ? usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens +
      usage.outputTokens
    : 0;
  return `- Description context: ${tokens} tokens · $${context.costUsd.toFixed(4)} (${context.model ?? "unknown model"})`;
}

/** Backticks would break the markdown around an author-written item. */
function inlineSafe(text: string): string {
  return text.replace(/`/g, "'");
}

/** "Author context used by the reviewer" (see the module doc); empty when the extractor did not run. */
function buildAuthorContextSection(
  context: DescriptionContextStageResult | null | undefined,
): string[] {
  if (!context) {
    return [];
  }
  const lines = ["### Author context used by the reviewer"];
  if (context.context === null) {
    lines.push(`- ${context.note ?? "The PR description was not used as review context."}`);
  } else {
    const kept = AUTHOR_CONTEXT_KINDS.flatMap((kind) =>
      (context.context?.[kind] ?? []).map(
        (item) => `- ${AUTHOR_CONTEXT_HEADINGS[kind]}: ${inlineSafe(item)}`,
      ),
    );
    lines.push(
      ...(kept.length > 0
        ? kept
        : ["- Nothing from the description was kept; the reviewer ran without author context."]),
    );
  }
  if (context.discarded.length > 0) {
    lines.push(
      "",
      "#### Discarded from the description",
      ...context.discarded.map((item) => `- ${inlineSafe(item)}`),
    );
  }
  return [...lines, ""];
}

/** Discarded items quoted in the visible line before "+N more". */
const MAX_VISIBLE_DISCARDED = 3;

/** The visible steering line (see the module doc); `null` when nothing was discarded. */
function steeringLine(
  context: DescriptionContextStageResult | null | undefined,
  language: string | undefined,
): string | null {
  if (!context || context.discarded.length === 0) {
    return null;
  }
  const es = verdictLanguage(language) === "es";
  const shown = context.discarded
    .slice(0, MAX_VISIBLE_DISCARDED)
    .map((item) => `"${inlineSafe(item)}"`)
    .join("; ");
  const more = context.discarded.length - MAX_VISIBLE_DISCARDED;
  const suffix = more > 0 ? ` (+${more} ${es ? "más" : "more"})` : "";
  const lead = es
    ? "Se ignoró en la descripción un intento de dirigir el review:"
    : "Ignored an attempt in the description to steer the review:";
  return `> **${lead}** ${shown}${suffix}.`;
}

/**
 * Code context and evidence (`reviewer.fullFile` / `impactContext` /
 * `requireEvidence`): what was added to the review prompts, or the one line
 * saying it could not be (no checkout), and the evidence check's count.
 * Nothing when the layers are off.
 */
function codeContextEfficiencyLines(metrics: RunMetrics): string[] {
  const context = metrics.codeContext;
  const lines: string[] = [];
  if (context.unavailable !== null) {
    lines.push(
      `- ${context.unavailable} (reviewer.fullFile / reviewer.impactContext skipped; they need actions/checkout of the PR head)`,
    );
  } else if (context.ran) {
    const chars = context.fullFileChars + context.impactChars;
    lines.push(
      `- Code context: ${plural(context.files, "file")}, ${plural(context.snippets, "snippet")}, ${chars} chars added to ${plural(context.hunks, "hunk")} (full file ${context.fullFileChars}, impact ${context.impactChars})`,
    );
  }
  if (context.evidenceChecked > 0) {
    lines.push(
      `- Evidence: ${context.evidenceRejected} of ${plural(context.evidenceChecked, "finding")} not published (evidence not found in code)`,
    );
  }
  return lines;
}

/** Agentic mode only: the agent run, the outcomes and drops, the verifier and Jev's judge. */
function agenticEfficiencyLines(metrics: RunMetrics): string[] {
  const a = metrics.agentic;
  if (!a) return [];
  const tools = Object.entries(a.toolCalls)
    .map(([tool, n]) => `${tool} ${n}`)
    .join(", ");
  const drops = Object.entries(a.dropsByReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  const o = a.outcomes;
  return [
    `- Agentic review: ${a.turns} turns · ${a.tokens.total} tokens · $${a.costUsd.toFixed(4)} (${a.model ?? a.status}) · tools: ${tools === "" ? "none" : tools}${a.deniedToolCalls > 0 ? ` · ${a.deniedToolCalls} denied` : ""}${a.diffFilesOmitted > 0 ? ` · ${plural(a.diffFilesOmitted, "file")} left out of the diff by the size cap` : ""}`,
    `- Agentic findings: ${a.findingsReported} reported → ${o.published} published, ${o.questions} questions, ${o.low} low, ${o.discarded} discarded${drops === "" ? "" : ` · dropped: ${drops}`}`,
    `- Verifier: ${plural(a.verifier.calls, "call")} · ${a.verifier.tokens} tokens · $${a.verifier.costUsd.toFixed(4)} · Jev judge: ${plural(a.jevJudgeCalls, "request")}`,
  ];
}

/** The closing section; see the module doc for why it is last and outside the fingerprint. */
function buildEfficiencySection(
  metrics: RunMetrics,
  narrative?: NarrateStageResult | null,
  descriptionContext?: DescriptionContextStageResult | null,
): string[] {
  const { jev, llm } = metrics;
  return [
    "### Efficiency",
    `- Jev: ${plural(jev.requests.total, "request")} · p95 latency ${jev.latency.p95Ms} ms · total Jev time ${jev.latency.sumMs} ms`,
    `- LLM: ${llm.hunks.reviewed} of ${llm.hunks.total} hunks reviewed${llm.hunks.failed > 0 ? ` · ${llm.hunks.failed} failed (reviewer error)` : ""} · ${skippedByReason(llm.hunks.skipped)}${llm.hunks.withSecret > 0 ? ` · ${llm.hunks.withSecret} with a redacted secret` : ""}`,
    `- LLM tokens: ${llm.tokens.spent} tokens spent (review ${llm.tokens.reviewInput + llm.tokens.reviewOutput}, summary ${llm.tokens.summaryInput + llm.tokens.summaryOutput}) · without Jev ≈ ${llm.tokensWithoutJev} · saved ≈ ${llm.tokensSavedPct}%`,
    ...(narrative ? [narrativeEfficiencyLine(narrative)] : []),
    ...(descriptionContext?.status === "extracted"
      ? [descriptionContextEfficiencyLine(descriptionContext)]
      : []),
    ...codeContextEfficiencyLines(metrics),
    ...agenticEfficiencyLines(metrics),
    `- ${llm.method}`,
  ];
}

/**
 * Joins the stable content, the unfingerprinted LLM-derived lines (author
 * context) and the efficiency section, fingerprinting only the first.
 */
function withEfficiency(
  stableLines: readonly string[],
  metrics: RunMetrics,
  unstable: {
    readonly lines?: readonly string[];
    readonly narrative?: NarrateStageResult | null | undefined;
    readonly descriptionContext?: DescriptionContextStageResult | null | undefined;
  } = {},
): { summaryMarkdown: string; summaryFingerprint: string } {
  const stable = stableLines.join("\n");
  const extra = unstable.lines && unstable.lines.length > 0 ? ["", ...unstable.lines] : [];
  return {
    summaryMarkdown: [
      stable,
      ...extra,
      ...(extra.length > 0 ? [] : [""]),
      ...buildEfficiencySection(metrics, unstable.narrative, unstable.descriptionContext),
    ].join("\n"),
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
  const authorContext = buildAuthorContextSection(input.descriptionContext);
  const steering = steeringLine(input.descriptionContext, input.language);
  const narrative = input.narrative;
  const plain = withEfficiency(stableSummaryLines(parts), input.metrics, {
    lines: authorContext,
    descriptionContext: input.descriptionContext,
  });
  if (!narrative || narrative.markdown === null) {
    const heads = [
      ...(narrative?.note ? [`> ${narrative.note}`] : []),
      ...(steering ? [steering] : []),
    ];
    return heads.length > 0
      ? { ...plain, summaryMarkdown: `${heads.join("\n\n")}\n\n${plain.summaryMarkdown}` }
      : plain;
  }
  const summaryMarkdown = [
    reviewHeading(input.language),
    "",
    narrative.markdown,
    "",
    // Never collapsed: "the reviewer failed" must not hide behind a click.
    ...parts.warning,
    // Nor a secret the author may have committed.
    ...parts.secrets,
    // Nor an attempt to steer the review through the description.
    ...(steering ? [steering, ""] : []),
    "<details>",
    "<summary>Jevest details</summary>",
    "",
    ...parts.head,
    ...parts.body,
    "",
    ...authorContext,
    ...buildEfficiencySection(input.metrics, narrative, input.descriptionContext),
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
  /** One "possible committed secret" line per flagged hunk (NFR-3); empty when none. */
  readonly secrets: string[];
  readonly body: string[];
}

function stableSummaryLines(parts: SummaryParts): string[] {
  return ["## Jevest review", "", ...parts.head, ...parts.warning, ...parts.secrets, ...parts.body];
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
    secrets: buildSecretWarnings(input.hunkProfile, input.language),
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
    triageHumanReviewLine(triage),
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
      ? buildOutsideDiffSection(findingFilter)
      : [
          "### Findings (high confidence)",
          buildHighConfidenceFindingsSection(findingFilter, input.review),
          "",
        ]),
    QUESTIONS_HEADING,
    buildNeedsHumanSection(findingFilter, triage, input.hunkProfile, input.review),
    "",
    `### Findings discarded: ${findingFilter.discarded.length}`,
    ...rejectedDiscardedLines(findingFilter),
    "",
    ...buildLowConfidenceSection(findingFilter),
    "",
    "### Cost breakdown",
    buildCostSection(input),
    "",
    "### Merge gate",
    `- Safe to automerge probability: ${mergeGate.safeToAutomergeProb}`,
    `- Gate conclusion: ${mergeGate.conclusion} (decides \`jevest:auto-merge-ok\` only; the check follows the review verdict)`,
  ];
}

/**
 * Discarded findings are only counted, except the ones the evidence check
 * rejected (`reviewer.requireEvidence`): those are listed with the reason,
 * because "the code does not say that" is worth seeing, unlike a band.
 */
function rejectedDiscardedLines(findingFilter: FindingFilterStageResult): string[] {
  return findingFilter.discarded
    .filter((f) => f.rejectedReason !== undefined)
    .map((f) => `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rejectedReason})`);
}

/** The human queue: doubts to answer, plus what a human has to check by hand. */
const QUESTIONS_HEADING = "### Questions and manual checks";

/** Triage's FR-2.4 needs_human signal: reported, no longer a label (the verdict label says what to do). */
function triageHumanReviewLine(triage: TriageStageResult): string {
  return `- Careful human review suggested by triage: ${triage.needsHumanLabel ? "yes" : "no"}`;
}

/**
 * The verdict and risk labels (review-verdict.ts `verdictLabelChanges`)
 * pushed onto the run's add/remove lists, with their definitions so the
 * adapter can create them with a color and a description.
 */
function applyVerdictLabels(
  verdict: ReviewVerdictResult,
  triage: TriageStageResult | null,
  language: string | undefined,
  labelsToAdd: string[],
  labelsToRemove: string[],
): LabelDefinition[] {
  const { add, remove } = verdictLabelChanges(
    verdict.verdict,
    triage ? triage.riskLevel : null,
    language,
  );
  labelsToAdd.push(...add.map((l) => l.name));
  labelsToRemove.push(...remove);
  return add;
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
  /** `reviewer.language`, for the verdict's title, summary and labels. */
  language?: string,
): ReviewPublication {
  const forcedNeutral = mismatchForcesNeutral(triage);
  // No LLM review by design (FR-2.3): clear, or a question on a mismatch.
  const verdict = decideReviewVerdict({
    published: 0,
    needsHuman: 0,
    llmReview: "skipped-by-triage",
    descriptionMismatch: forcedNeutral,
    injectionSuspected: false,
    // Hunks are never profiled on a triage-only run, so none is flagged.
    secretsDetected: 0,
  });
  const summaryLines = [
    "## Jevest review",
    "",
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    "- LLM review skipped (FR-2.3): low risk, high confidence, no suspected instruction injection.",
    triageHumanReviewLine(triage),
    "",
    ...buildIntentVsChangeSection(triage),
    ...(mismatchIsActionable(triage) ? [QUESTIONS_HEADING, mismatchQueueLine(triage), ""] : []),
    "### Cost breakdown",
    summaryCostLine(triage),
  ];

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [AUTO_MERGE_OK_LABEL];
  const labelDefinitions = applyVerdictLabels(
    verdict,
    triage,
    language,
    labelsToAdd,
    labelsToRemove,
  );
  applyTriageV2Labels(triage, labelsToAdd, labelsToRemove);

  return {
    ...withEfficiency(summaryLines, metrics),
    inlineComments: [],
    labelsToAdd,
    labelsToRemove,
    labelDefinitions,
    check: {
      conclusion: verdictConclusion(verdict.verdict),
      title: verdictTitle(verdict, language),
      summary: `${verdictSummary(verdict, language)} Triage: ${triage.category}/${triage.riskLevel}. LLM review skipped per FR-2.3 (low risk).${forcedNeutral ? MISMATCH_CHECK_LINE : ""}`,
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
  /** `reviewer.language`, for the verdict's title and labels. */
  language?: string,
): ReviewPublication {
  // Verdict `unavailable`, but the check stays `failure`: NFR-2's fail
  // closed is a safety override this module never weakens.
  const verdict = decideReviewVerdict({
    published: 0,
    needsHuman: 0,
    llmReview: "failed-closed",
    descriptionMismatch: false,
    injectionSuspected: false,
    secretsDetected: 0,
  });
  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [AUTO_MERGE_OK_LABEL];
  const labelDefinitions = applyVerdictLabels(
    verdict,
    lastKnownTriage,
    language,
    labelsToAdd,
    labelsToRemove,
  );
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
    labelsToAdd,
    labelsToRemove,
    labelDefinitions,
    check: {
      conclusion: "failure",
      title: verdictTitle(verdict, language),
      summary: detail
        ? `${failedStage} failed — failing closed per NFR-2: ${detail}`
        : `Jev unavailable during ${failedStage} — failing closed per NFR-2.`,
    },
  };
}

export interface PublishVerdict {
  /** The run's review verdict with its counts (review-verdict.ts). */
  readonly verdict: ReviewVerdictResult;
  /** The check conclusion: the verdict's, always. */
  readonly conclusion: "success" | "neutral" | "failure";
  /** `jevest:auto-merge-ok`: the merge gate is green AND the verdict is clear. */
  readonly autoMergeOk: boolean;
  /** Every attempted reviewer call failed (NFR-2). */
  readonly reviewFailedEntirely: boolean;
  /** An auto-band description mismatch counted as a question. */
  readonly mismatchQuestion: boolean;
  /** Instructions to a reviewer suspected in the description or the diff. */
  readonly injectionSuspected: boolean;
  /** Hunks where the redactor found a possible secret (NFR-3). */
  readonly secretsDetected: number;
}

function llmReviewOutcome(
  input: Pick<PublishStageInput, "review" | "reviewDisabled" | "reviewSkippedForSpendCap">,
): LlmReviewOutcome {
  if (input.reviewDisabled) return "disabled";
  if (input.reviewSkippedForSpendCap === true) return "skipped-for-spend-cap";
  if (allReviewsFailed(input.review)) return "failed-entirely";
  return "ran";
}

/**
 * The verdict the publication will carry. Exported so the review narrator
 * is told the same verdict, in the same words, as the check. The safety
 * rules survive the switch from the gate to the verdict: an auto-band
 * mismatch and a suspected injection can never produce a green check (the
 * verdict is at most neutral), all-reviews-failed is `unavailable`, and
 * auto-merge-ok needs both the gate and a clear verdict.
 */
export function resolvePublishVerdict(
  input: Pick<
    PublishStageInput,
    | "triage"
    | "hunkProfile"
    | "review"
    | "findingFilter"
    | "mergeGate"
    | "reviewDisabled"
    | "reviewSkippedForSpendCap"
    | "injectedInstructionsInDescription"
  >,
): PublishVerdict {
  const reviewFailedEntirely = allReviewsFailed(input.review);
  const mismatchQuestion = mismatchForcesNeutral(input.triage);
  const injectionSuspected =
    input.injectedInstructionsInDescription === true || injectedInDiff(input.hunkProfile);
  const secretsDetected = secretHunks(input.hunkProfile).length;
  const verdict = decideReviewVerdict({
    published: input.findingFilter.published.length,
    needsHuman: input.findingFilter.needsHuman.length,
    llmReview: llmReviewOutcome(input),
    descriptionMismatch: mismatchQuestion,
    injectionSuspected,
    secretsDetected,
  });
  return {
    verdict,
    conclusion: verdictConclusion(verdict.verdict),
    autoMergeOk: input.mergeGate.conclusion === "success" && verdict.verdict === "clear",
    reviewFailedEntirely,
    mismatchQuestion,
    injectionSuspected,
    secretsDetected,
  };
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
    verdict,
    conclusion,
    autoMergeOk,
    reviewFailedEntirely,
    mismatchQuestion,
    injectionSuspected,
    secretsDetected,
  } = resolvePublishVerdict(input);

  if (autoMergeOk) {
    labelsToAdd.push(AUTO_MERGE_OK_LABEL);
  } else {
    labelsToRemove.push(AUTO_MERGE_OK_LABEL);
  }
  const labelDefinitions = applyVerdictLabels(
    verdict,
    input.triage,
    input.language,
    labelsToAdd,
    labelsToRemove,
  );
  applyTriageV2Labels(input.triage, labelsToAdd, labelsToRemove);
  applyInjectedInstructionsLabel(input.hunkProfile, labelsToAdd, labelsToRemove);
  applySpendCapLabels(input.spendCap, labelsToAdd, labelsToRemove);

  const failedCount = failedReviews(input.review).length;
  const reviewFailedCheckLine =
    failedCount > 0
      ? ` LLM review failed on ${failedCount} of ${input.review.reviews.length} hunk(s); those were not reviewed.${reviewFailedEntirely ? " Nothing is marked safe to auto-merge." : ""}`
      : "";
  const secretCheckLine =
    secretsDetected > 0
      ? ` A possible committed secret was found in ${secretsDetected} hunk(s) (redacted before review): check it and rotate it if it is real.`
      : "";
  const injectionCheckLine = injectionSuspected
    ? " Instructions to a reviewer were suspected in the pull request; the automated review cannot be trusted on its own."
    : "";

  return {
    ...summary,
    inlineComments,
    labelsToAdd,
    labelsToRemove,
    labelDefinitions,
    check: {
      conclusion,
      title: verdictTitle(verdict, input.language),
      summary: `${verdictSummary(verdict, input.language)} Triage: ${input.triage.category}/${input.triage.riskLevel}.${reviewFailedCheckLine}${mismatchQuestion ? MISMATCH_CHECK_LINE : ""}${injectionCheckLine}${secretCheckLine}${spendCapCheckLine(input.spendCap)}`,
    },
  };
}
