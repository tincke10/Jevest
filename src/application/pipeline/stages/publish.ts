/**
 * Stage 6: publish (SPEC FR-7). Pure data transform — no ports, no I/O — so
 * it stays synchronous, unlike the other stages. Builds the VcsPort-shaped
 * `ReviewPublication` from every prior stage's result: inline comments only
 * for auto-band findings (`findingFilter.published`); a markdown summary
 * covering the triage decision, skipped hunks, needs-human findings,
 * discarded count and cost breakdown; and the labels/check for the merge
 * gate outcome. Fingerprints are `sha256` of stable content (path/line/claim
 * for a comment, the whole summary text for the summary) so a re-run over
 * unchanged input reproduces the exact same fingerprints (NFR-12).
 *
 * Triage v2 (H7) adds an "Intent vs change" section (what the change
 * summary says, product areas touched with their criticality, the
 * description-vs-change verdict with its probability, the product-owner
 * flag), two labels (`jevest:description-mismatch`,
 * `jevest:needs-product-owner`) and one consequence on the check: a
 * mismatch in the AUTO band forces a green check to neutral and lists the
 * PR in the human queue. It never turns a check red on its own — that is
 * the merge gate's call.
 */
import { createHash } from "node:crypto";
import { mapBeforeLineToAfterLine } from "../../../domain/hunk-splitter.js";
import type { InlineComment, ReviewPublication } from "../../../domain/ports/vcs-port.js";
import type { SpendCapEvaluation } from "../../../domain/spend-cap.js";
import type { FindingFilterStageResult } from "./finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";
import type { MergeGateStageResult } from "./merge-gate.js";
import type { ReviewStageResult } from "./review.js";
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
}

const AUTO_MERGE_OK_LABEL = "jevest:auto-merge-ok";
const NEEDS_HUMAN_LABEL = "jevest:needs-human";
const SPEND_WARNING_LABEL = "jevest:spend-warning";
const SPEND_CAP_REACHED_LABEL = "jevest:spend-cap-reached";
const DESCRIPTION_MISMATCH_LABEL = "jevest:description-mismatch";
const NEEDS_PRODUCT_OWNER_LABEL = "jevest:needs-product-owner";

function usd(value: number): string {
  return value.toFixed(2);
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
      `- No change summary: the summarizer failed (${triage.summaryError}). Triage ran on file facts only, without the summary.`,
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
): string {
  const lines = findingFilter.needsHuman.map((f) => {
    const suffix = f.unverified ? " — unverified (Jev unavailable)" : "";
    return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})${suffix}`;
  });
  if (mismatchIsActionable(triage)) {
    lines.push(mismatchQueueLine(triage));
  }
  if (lines.length === 0) {
    return "No findings need human review.";
  }
  return lines.join("\n");
}

function buildHighConfidenceFindingsSection(findingFilter: FindingFilterStageResult): string {
  if (findingFilter.published.length === 0) {
    return "No high-confidence findings.";
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

function buildSummaryMarkdown(input: PublishStageInput): string {
  const { triage, findingFilter, mergeGate } = input;

  const skippedForSpendCap = input.reviewSkippedForSpendCap === true;
  const spendCapBanner =
    skippedForSpendCap && input.spendCap
      ? `**LLM review skipped: spend cap reached** — USD ${usd(input.spendCap.spentUsd)} of ${usd(input.spendCap.capUsd)} ${periodWording(input.spendCap)}. Jev-only run; raise \`spendCap.usd\` or reset the ledger to resume LLM reviews.`
      : "**LLM review skipped: spend cap reached** — Jev-only run.";

  return [
    "## Jevest review",
    "",
    ...(skippedForSpendCap ? [spendCapBanner, ""] : []),
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    `- LLM review skipped: ${triage.skipLlmReview}`,
    `- Needs human: ${triage.needsHumanLabel}`,
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
      : ["### Findings (high confidence)", buildHighConfidenceFindingsSection(findingFilter), ""]),
    "### Needs human review",
    buildNeedsHumanSection(findingFilter, triage),
    "",
    `### Findings discarded: ${findingFilter.discarded.length}`,
    "",
    "### Cost breakdown",
    buildCostSection(input),
    "",
    "### Merge gate",
    `- Safe to automerge probability: ${mergeGate.safeToAutomergeProb}`,
    `- Conclusion: ${mergeGate.conclusion}`,
  ].join("\n");
}

/**
 * FR-2.3: when triage decides the LLM review can be skipped (low risk,
 * high confidence, no suspected injection), the pipeline never runs
 * hunk-profile/review/finding-filter/merge-gate — it publishes only the
 * triage label and a short summary, per the spec's literal wording ("se
 * publica solo label y resumen de triage").
 */
export function runTriageOnlyPublishStage(triage: TriageStageResult): ReviewPublication {
  const forcedNeutral = mismatchForcesNeutral(triage);
  const summaryMarkdown = [
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
  ].join("\n");

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [AUTO_MERGE_OK_LABEL];
  if (triage.needsHumanLabel) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }
  applyTriageV2Labels(triage, labelsToAdd, labelsToRemove);

  return {
    summaryMarkdown,
    summaryFingerprint: sha256(summaryMarkdown),
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

export function runPublishStage(input: PublishStageInput): ReviewPublication {
  const summaryMarkdown = buildSummaryMarkdown(input);
  const hunksById = new Map(input.hunkProfile.hunks.map((h) => [h.id, h]));
  const inlineComments = input.inlineCommentsEnabled
    ? buildInlineComments(input.findingFilter, hunksById)
    : [];

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [];

  // An auto-band description mismatch downgrades a green gate to neutral
  // (a human must compare the story with the diff); it never overrides a
  // neutral or red gate, and never turns anything red by itself.
  const forcedNeutral =
    mismatchForcesNeutral(input.triage) && input.mergeGate.conclusion === "success";
  const conclusion = forcedNeutral ? "neutral" : input.mergeGate.conclusion;

  if (conclusion === "success") {
    labelsToAdd.push(AUTO_MERGE_OK_LABEL);
  } else {
    labelsToRemove.push(AUTO_MERGE_OK_LABEL);
  }

  if (input.triage.needsHumanLabel) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }
  applyTriageV2Labels(input.triage, labelsToAdd, labelsToRemove);
  applySpendCapLabels(input.spendCap, labelsToAdd, labelsToRemove);

  const mismatchCheckLine = forcedNeutral
    ? " The PR description does not match the change; a human should look."
    : "";

  return {
    summaryMarkdown,
    summaryFingerprint: sha256(summaryMarkdown),
    inlineComments,
    labelsToAdd,
    labelsToRemove,
    check: {
      conclusion,
      title: `Jevest: ${conclusion}`,
      summary: `Triage: ${input.triage.category}/${input.triage.riskLevel}. Published ${input.findingFilter.published.length} finding(s), ${input.findingFilter.needsHuman.length} need human review.${mismatchCheckLine}${spendCapCheckLine(input.spendCap)}`,
    },
  };
}
