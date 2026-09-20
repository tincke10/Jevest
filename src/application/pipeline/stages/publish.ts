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
 */
import { createHash } from "node:crypto";
import { mapBeforeLineToAfterLine } from "../../../domain/hunk-splitter.js";
import type { InlineComment, ReviewPublication } from "../../../domain/ports/vcs-port.js";
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
}

const AUTO_MERGE_OK_LABEL = "jevest:auto-merge-ok";
const NEEDS_HUMAN_LABEL = "jevest:needs-human";

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

function buildNeedsHumanSection(findingFilter: FindingFilterStageResult): string {
  if (findingFilter.needsHuman.length === 0) {
    return "No findings need human review.";
  }
  return findingFilter.needsHuman
    .map((f) => {
      const suffix = f.unverified ? " — unverified (Jev unavailable)" : "";
      return `- \`${f.file}\` line ${f.lineStart}: ${f.claim} (${f.rationale})${suffix}`;
    })
    .join("\n");
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
    `- Jev decision usage: ${jevUsage.inputTokens} input tokens, ${jevUsage.outputTokens} output tokens`,
  ].join("\n");
}

function buildSummaryMarkdown(input: PublishStageInput): string {
  const { triage, findingFilter, mergeGate } = input;

  return [
    "## Jevest review",
    "",
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    `- LLM review skipped: ${triage.skipLlmReview}`,
    `- Needs human: ${triage.needsHumanLabel}`,
    "",
    ...(input.reviewDisabled
      ? ["", "**LLM review disabled by config** (reviewer.provider: none — Jev-only mode)."]
      : []),
    "",
    "### Skipped hunks",
    buildSkippedHunksSection(input.hunkProfile),
    "",
    ...(input.inlineCommentsEnabled
      ? []
      : ["### Findings (high confidence)", buildHighConfidenceFindingsSection(findingFilter), ""]),
    "### Needs human review",
    buildNeedsHumanSection(findingFilter),
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
  const summaryMarkdown = [
    "## Jevest review",
    "",
    "### Triage",
    `- Category: ${triage.category}`,
    `- Risk level: ${triage.riskLevel}`,
    "- LLM review skipped (FR-2.3): low risk, high confidence, no suspected instruction injection.",
    `- Needs human: ${triage.needsHumanLabel}`,
  ].join("\n");

  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [AUTO_MERGE_OK_LABEL];
  if (triage.needsHumanLabel) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }

  return {
    summaryMarkdown,
    summaryFingerprint: sha256(summaryMarkdown),
    inlineComments: [],
    labelsToAdd,
    labelsToRemove,
    check: {
      conclusion: "success",
      title: "Jevest: skipped (low risk)",
      summary: `Triage: ${triage.category}/${triage.riskLevel}. LLM review skipped per FR-2.3.`,
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
): ReviewPublication {
  const summaryMarkdown = [
    "## Jevest review",
    "",
    "### Pipeline failed closed (NFR-2)",
    `Jev did not respond during the **${failedStage}** stage.`,
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
      summary: `Jev unavailable during ${failedStage} — failing closed per NFR-2.`,
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

  if (input.mergeGate.conclusion === "success") {
    labelsToAdd.push(AUTO_MERGE_OK_LABEL);
  } else {
    labelsToRemove.push(AUTO_MERGE_OK_LABEL);
  }

  if (input.triage.needsHumanLabel) {
    labelsToAdd.push(NEEDS_HUMAN_LABEL);
  } else {
    labelsToRemove.push(NEEDS_HUMAN_LABEL);
  }

  return {
    summaryMarkdown,
    summaryFingerprint: sha256(summaryMarkdown),
    inlineComments,
    labelsToAdd,
    labelsToRemove,
    check: {
      conclusion: input.mergeGate.conclusion,
      title: `Jevest: ${input.mergeGate.conclusion}`,
      summary: `Triage: ${input.triage.category}/${input.triage.riskLevel}. Published ${input.findingFilter.published.length} finding(s), ${input.findingFilter.needsHuman.length} need human review.`,
    },
  };
}
