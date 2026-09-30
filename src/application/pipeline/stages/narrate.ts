/**
 * Colleague review: one ReviewNarratorPort call per PR, after the finding
 * filter and the merge gate, turning what Jev kept into the review a
 * senior colleague would write (see review-narrator-port.ts). Not one of
 * SPEC §3's six stages: it adds no decision and moves no finding, it only
 * phrases the ones already decided.
 *
 * What the narrator gets is chosen here, on purpose narrow: the PR title
 * and description, the changed file paths, the diff of the hunks the LLM
 * reviewer actually reviewed (never a failed or skipped hunk — a skipped
 * one may be a secret), and ONLY the findings Jev kept (`published`) plus
 * the `needsHuman` ones flagged as doubts. `lowConfidence` and `discarded`
 * never reach it: a narrator that saw them could resurrect what the filter
 * dropped. Lines are HEAD-side, like the inline comments.
 *
 * The narrative is an ENHANCER, like the change summary: a narrator error
 * never fails the run. It becomes a one-line note and the summary comment
 * falls back to the full report. Whether to call the narrator at all
 * (config, budget, all reviews failed, suspected injection) is the
 * pipeline's decision; {@link narrativeSkipped} is how it says "not run".
 */
import type { FindingSeverity } from "../../../domain/finding.js";
import { mapBeforeLineToAfterLine } from "../../../domain/hunk-splitter.js";
import type {
  NarratedFinding,
  ReviewNarrativeInput,
  ReviewNarratorPort,
} from "../../../domain/ports/review-narrator-port.js";
import type { ReviewUsage } from "../../../domain/ports/reviewer-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { type ReviewVerdictResult, verdictTitle } from "../../../domain/review-verdict.js";
import { type ModelPricing, reviewCostUsd } from "../../findings/pricing.js";
import type { FilteredFinding, FindingFilterStageResult } from "./finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";
import type { ReviewStageResult } from "./review.js";

export interface NarrateStageInput {
  readonly pr: PullRequestData;
  readonly hunkProfile: HunkProfileStageResult;
  readonly review: ReviewStageResult;
  readonly findingFilter: FindingFilterStageResult;
  /** The verdict the check will carry (publish.ts `resolvePublishVerdict`); its title is the narrative's closing line. */
  readonly verdict: ReviewVerdictResult;
  readonly narrator: ReviewNarratorPort;
  /** `reviewer.language`. */
  readonly language: string;
  /** Rate table when the adapter reports no nominal cost (the reviewer model's). */
  readonly pricing: ModelPricing;
}

export interface NarrateStageResult {
  /** The review body; `null` when the narrator failed or was not run (`note` says why). */
  readonly markdown: string | null;
  /** One line for the summary comment when there is no markdown; `null` otherwise. */
  readonly note: string | null;
  readonly model: string | null;
  readonly usage: ReviewUsage | null;
  /** 0 unless a narrative was written. Nominal cost when the adapter reports one, else priced from usage. */
  readonly costUsd: number;
  readonly latencyMs: number;
}

const FALLBACK = "showing the full Jevest report instead.";
/** Longest error message kept in the note; provider errors can embed whole response bodies. */
const MAX_NOTE_ERROR_CHARS = 300;

function oneLine(message: string): string {
  const flat = message.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > MAX_NOTE_ERROR_CHARS ? `${flat.slice(0, MAX_NOTE_ERROR_CHARS - 1)}…` : flat;
}

/** The pipeline decided not to call the narrator; `reason` ends up in the comment. */
export function narrativeSkipped(reason: string): NarrateStageResult {
  return {
    markdown: null,
    note: `The review narrative was skipped (${reason}); ${FALLBACK}`,
    model: null,
    usage: null,
    costUsd: 0,
    latencyMs: 0,
  };
}

const SEVERITIES: readonly FindingSeverity[] = ["nit", "minor", "major", "critical"];

/** Same rounding and clamp as the merge gate's severity counts (run-pipeline.ts). */
function severityWord(jevSeverityScore: number): FindingSeverity {
  return SEVERITIES[Math.min(3, Math.max(0, Math.round(jevSeverityScore)))] ?? "minor";
}

function toNarratedFinding(
  finding: FilteredFinding,
  hunksById: ReadonlyMap<string, HunkProfileEntry>,
  needsHuman: boolean,
): NarratedFinding {
  // Before-side lines from the reviewer, mapped like the inline comments.
  const hunk = hunksById.get(finding.hunkId);
  const line = hunk ? mapBeforeLineToAfterLine(hunk, finding.lineStart) : finding.lineStart;
  const lineEnd = hunk ? mapBeforeLineToAfterLine(hunk, finding.lineEnd) : finding.lineEnd;
  return {
    file: finding.file,
    line,
    lineEnd: Math.max(line, lineEnd),
    claim: finding.claim,
    rationale: finding.rationale,
    severity: severityWord(finding.jevSeverityScore),
    needsHuman,
  };
}

function toNarrativeInput(input: NarrateStageInput): ReviewNarrativeInput {
  const hunksById = new Map(input.hunkProfile.hunks.map((h) => [h.id, h]));
  const reviewed = input.review.reviews
    .filter((r) => r.error === null)
    .map((r) => hunksById.get(r.hunkId))
    .filter((h): h is HunkProfileEntry => h !== undefined);
  const { ref } = input.pr;
  return {
    prId: `${ref.owner}/${ref.repo}#${ref.number}`,
    title: input.pr.title,
    description: input.pr.body,
    changedFiles: input.pr.files.map((f) => f.path),
    hunks: reviewed.map((h) => ({ file: h.file, hunkHeader: h.hunkHeader, diff: h.diff })),
    findings: [
      ...input.findingFilter.published.map((f) => toNarratedFinding(f, hunksById, false)),
      ...input.findingFilter.needsHuman.map((f) => toNarratedFinding(f, hunksById, true)),
    ],
    language: input.language,
    verdict: input.verdict.verdict,
    verdictLine: verdictTitle(input.verdict, input.language),
  };
}

export async function runNarrateStage(input: NarrateStageInput): Promise<NarrateStageResult> {
  try {
    const output = await input.narrator.narrate(toNarrativeInput(input));
    return {
      markdown: output.markdown,
      note: null,
      model: output.model,
      usage: output.usage,
      // Same rule as the review and the summary: a subscription-billed
      // adapter's nominal cost is what the budget tracks.
      costUsd: output.nominalCostUsd ?? reviewCostUsd(output.usage, input.pricing),
      latencyMs: output.latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`jevest: review narrative failed (${message}); publishing the report without it`);
    return {
      markdown: null,
      note: `The review narrative failed (${oneLine(message)}); ${FALLBACK}`,
      model: null,
      usage: null,
      costUsd: 0,
      latencyMs: 0,
    };
  }
}
