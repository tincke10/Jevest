/**
 * Stage 2: hunk profile (SPEC FR-3, §4.3 provisional split). Jev answers
 * `change_kind`, `touches_error_handling`, `touches_async` and
 * `contains_reviewer_instructions` per hunk (§4.3: `touches_public_api` is
 * derived in code by AST, since the `export` line is often outside the
 * hunk; `touches_io` is dropped until there's more labeled support). One
 * Jev request per hunk (NFR-14) — the question set lives in
 * `hunk-profile-questions.ts` (the three surface questions reused verbatim
 * from the spike, plus the injection one). These Jev questions run on the
 * raw diff for ANY language — the language gate below applies only to the
 * AST-based `touchesPublicApi`.
 *
 * In-diff injection (NFR-7, second half): the diff is this stage's state,
 * so it is the place to ask whether a hunk talks to the reviewer. The
 * per-hunk probability is folded in code into one stage-level verdict
 * (`injectedInstructionsInDiff`: the maximum and the hunks at or above the
 * "yes" bar), which the merge gate receives as a WORD (NFR-5) and publish
 * turns into a label and a human-queue line. A secret hunk or a failed
 * profile has no probability (`null`) and never raises the verdict.
 *
 * Language gate: `ast-labels.ts` parses everything as TypeScript, so
 * `touchesPublicApi` is only meaningful for actual TypeScript/JavaScript
 * source (`languageFromPath`). For a `.vue` file, the `<script>`/`<script
 * setup>` block is extracted and labeled on its own if present; a
 * template-only hunk (no script block) is treated the same as an
 * unsupported language. Any other language (PHP, Blade, etc.) always sets
 * `touchesPublicApi: null` and `astSkipped: "unsupported-language"` —
 * never guessed from a TypeScript parse of code that isn't TypeScript.
 */
import { touchesPublicApi } from "../../../domain/ast-labels.js";
import {
  type ConfidencePolicyConfig,
  createConfidencePolicy,
} from "../../../domain/confidence-policy.js";
import type { Usage } from "../../../domain/decision.js";
import { type SplitHunk, splitFileIntoHunks } from "../../../domain/hunk-splitter.js";
import { extractVueScript, languageFromPath } from "../../../domain/language.js";
import type { DecisionPort } from "../../../domain/ports/decision-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { containsSecret, redact } from "../../../domain/redact.js";
import { pipelineHunkProfileQuestionSet } from "./hunk-profile-questions.js";
import type { RiskLevel } from "./triage.js";

const pipelineProfileQuestions = pipelineHunkProfileQuestionSet.questions;

/** P(contains_reviewer_instructions) at or above which a hunk is reported as carrying instructions ("yes"). */
export const INJECTED_INSTRUCTIONS_IN_DIFF_YES_MIN_PROB = 0.5;
/** Below the "yes" bar but at or above this, the verdict is "unclear"; below it, "no". */
export const INJECTED_INSTRUCTIONS_IN_DIFF_UNCLEAR_MIN_PROB = 0.3;

export type InjectedInstructionsInDiffWord = "yes" | "no" | "unclear";

/** The word the merge gate sees for the diff (NFR-5: never the raw probability). */
export function injectedInstructionsInDiffWord(maxProb: number): InjectedInstructionsInDiffWord {
  if (maxProb >= INJECTED_INSTRUCTIONS_IN_DIFF_YES_MIN_PROB) return "yes";
  if (maxProb >= INJECTED_INSTRUCTIONS_IN_DIFF_UNCLEAR_MIN_PROB) return "unclear";
  return "no";
}

export interface InjectedInstructionsInDiff {
  /** Highest `containsReviewerInstructionsProb` across the profiled hunks; 0 when none was profiled. */
  readonly maxProb: number;
  /** Ids of the hunks at or above the "yes" bar, in PR order. */
  readonly hunkIds: readonly string[];
}

/** Why `touchesPublicApi` is `null` for a hunk (AST labeling was not possible). */
export type AstSkipReason = "unsupported-language";

export interface HunkProfileEntry {
  readonly id: string;
  readonly file: string;
  readonly hunkHeader: string;
  readonly before: string;
  readonly diff: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly changeKind: string | null;
  readonly changeKindConfidence: number | null;
  readonly touchesErrorHandlingProb: number | null;
  readonly touchesAsyncProb: number | null;
  /** NFR-7: P(the hunk's text addresses a reviewer/bot/AI and tells it what to do); `null` when Jev did not profile the hunk. */
  readonly containsReviewerInstructionsProb: number | null;
  /** `null` when the file's language doesn't support AST labeling — see `astSkipped`. */
  readonly touchesPublicApi: boolean | null;
  /** True when computed from the hunk fragment alone (no full-file fetch available). */
  readonly touchesPublicApiPartial: boolean;
  /** Set when `touchesPublicApi` is `null` because AST labeling doesn't apply to this file's language. */
  readonly astSkipped: AstSkipReason | null;
  readonly requestId: string | null;
  readonly latencyMs: number;
  readonly usage: Usage;
  /** FR-3.3: change_kind in skipChangeKinds at auto-band confidence, or NFR-3 secret. */
  readonly skippedFromReview: boolean;
  /** NFR-3: hunk contains a secret, marked and never sent to Jev or the LLM. */
  readonly containsSecret: boolean;
  /** NFR-2 fail-closed: Jev failed to profile this hunk (timeout/error) — still sent to review, just without profile context. */
  readonly profileFailed: boolean;
}

export interface HunkProfileStageInput {
  readonly pr: PullRequestData;
  readonly decisionPort: DecisionPort;
  readonly policyConfig: ConfidencePolicyConfig;
  readonly riskLevel: RiskLevel;
  readonly skipChangeKinds: readonly string[];
  readonly maxHunks: number;
  /** Optional: fetch a file's full content at a given sha, for full-file AST context (§4.3). */
  readonly fetchFileContent?: (path: string, sha: string) => Promise<string | null>;
}

export interface HunkProfileStageResult {
  readonly hunks: HunkProfileEntry[];
  /** Stage-level in-diff injection verdict, computed in code from the per-hunk probabilities. */
  readonly injectedInstructionsInDiff: InjectedInstructionsInDiff;
  readonly truncatedHunkCount: number;
  readonly totalRequests: number;
  readonly totalLatencyMs: number;
  readonly totalUsage: Usage;
}

interface PublicApiResolution {
  readonly touchesPublicApi: boolean | null;
  readonly partial: boolean;
  readonly astSkipped: AstSkipReason | null;
}

const UNSUPPORTED_LANGUAGE: PublicApiResolution = {
  touchesPublicApi: null,
  partial: false,
  astSkipped: "unsupported-language",
};

async function resolvePublicApi(
  hunk: SplitHunk,
  pr: PullRequestData,
  fetchFileContent: HunkProfileStageInput["fetchFileContent"],
): Promise<PublicApiResolution> {
  const language = languageFromPath(hunk.file);

  if (language === "typescript" || language === "javascript") {
    if (fetchFileContent) {
      const [fullBefore, fullAfter] = await Promise.all([
        fetchFileContent(hunk.file, pr.ref.baseSha),
        fetchFileContent(hunk.file, pr.ref.headSha),
      ]);
      if (fullBefore !== null && fullAfter !== null) {
        return {
          touchesPublicApi: touchesPublicApi(fullBefore, fullAfter),
          partial: false,
          astSkipped: null,
        };
      }
    }
    return {
      touchesPublicApi: touchesPublicApi(hunk.before, hunk.after),
      partial: true,
      astSkipped: null,
    };
  }

  if (language === "vue") {
    const beforeScript = extractVueScript(hunk.before);
    const afterScript = extractVueScript(hunk.after);
    if (beforeScript === null && afterScript === null) {
      // Template-only hunk — nothing script-shaped to label.
      return UNSUPPORTED_LANGUAGE;
    }
    return {
      touchesPublicApi: touchesPublicApi(beforeScript ?? "", afterScript ?? ""),
      partial: true,
      astSkipped: null,
    };
  }

  return UNSUPPORTED_LANGUAGE;
}

/** Max over the hunks Jev actually profiled, plus the ids at or above the "yes" bar (PR order). */
function foldInjectedInstructions(
  entries: readonly HunkProfileEntry[],
): InjectedInstructionsInDiff {
  let maxProb = 0;
  const hunkIds: string[] = [];
  for (const entry of entries) {
    const prob = entry.containsReviewerInstructionsProb;
    if (prob === null) continue;
    maxProb = Math.max(maxProb, prob);
    if (prob >= INJECTED_INSTRUCTIONS_IN_DIFF_YES_MIN_PROB) hunkIds.push(entry.id);
  }
  return { maxProb, hunkIds };
}

export async function runHunkProfileStage(
  input: HunkProfileStageInput,
): Promise<HunkProfileStageResult> {
  const allHunks: SplitHunk[] = [];
  for (const file of input.pr.files) {
    allHunks.push(...splitFileIntoHunks(file.path, file.patch));
  }

  const hunksToProcess = allHunks.slice(0, input.maxHunks);
  const truncatedHunkCount = allHunks.length - hunksToProcess.length;

  const policy = createConfidencePolicy(input.policyConfig);
  const entries: HunkProfileEntry[] = [];
  let totalRequests = 0;
  let totalLatencyMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const [index, hunk] of hunksToProcess.entries()) {
    const id = `${hunk.file}#${index}`;
    const secretCheck = containsSecret(hunk.diff);

    const {
      touchesPublicApi: hasPublicApi,
      partial,
      astSkipped,
    } = await resolvePublicApi(hunk, input.pr, input.fetchFileContent);

    if (secretCheck) {
      entries.push({
        id,
        file: hunk.file,
        hunkHeader: hunk.hunkHeader,
        before: redact(hunk.before).text,
        diff: redact(hunk.diff).text,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        changeKind: null,
        changeKindConfidence: null,
        touchesErrorHandlingProb: null,
        touchesAsyncProb: null,
        containsReviewerInstructionsProb: null,
        touchesPublicApi: hasPublicApi,
        touchesPublicApiPartial: partial,
        astSkipped,
        requestId: null,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        skippedFromReview: true,
        containsSecret: true,
        profileFailed: false,
      });
      continue;
    }

    const questions: Record<
      string,
      ReturnType<(typeof pipelineProfileQuestions)[number]["build"]>
    > = {};
    for (const question of pipelineProfileQuestions) {
      questions[question.name] = question.build();
    }

    let response: Awaited<ReturnType<typeof input.decisionPort.decide>>;
    try {
      response = await input.decisionPort.decide(hunk.diff, questions);
    } catch {
      // NFR-2 fail-closed: a Jev failure on one hunk doesn't abort the whole
      // stage or lose the hunks already profiled. The hunk still goes to
      // review (skippedFromReview stays false — we can't safely apply the
      // skip-change-kind optimization without a change_kind), just without
      // profile context (nullable fields, same shape as the secret path).
      entries.push({
        id,
        file: hunk.file,
        hunkHeader: hunk.hunkHeader,
        before: hunk.before,
        diff: hunk.diff,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        changeKind: null,
        changeKindConfidence: null,
        touchesErrorHandlingProb: null,
        touchesAsyncProb: null,
        containsReviewerInstructionsProb: null,
        touchesPublicApi: hasPublicApi,
        touchesPublicApiPartial: partial,
        astSkipped,
        requestId: null,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        skippedFromReview: false,
        containsSecret: false,
        profileFailed: true,
      });
      continue;
    }
    totalRequests += 1;
    totalLatencyMs += response.latencyMs;
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    const changeKindDecision = response.answers.change_kind;
    const errHandlingDecision = response.answers.touches_error_handling;
    const asyncDecision = response.answers.touches_async;
    const reviewerInstructionsDecision = response.answers.contains_reviewer_instructions;
    if (
      changeKindDecision?.type !== "choice" ||
      errHandlingDecision?.type !== "noul" ||
      asyncDecision?.type !== "noul" ||
      reviewerInstructionsDecision?.type !== "noul"
    ) {
      throw new Error("hunk-profile: unexpected decision shape from DecisionPort");
    }

    const skipEligible = input.skipChangeKinds.includes(changeKindDecision.choice);
    const confidenceBand = policy.band(
      "hunk_profile",
      input.riskLevel,
      changeKindDecision.confidence,
    );
    const skippedFromReview = skipEligible && confidenceBand === "auto";

    entries.push({
      id,
      file: hunk.file,
      hunkHeader: hunk.hunkHeader,
      before: hunk.before,
      diff: hunk.diff,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      changeKind: changeKindDecision.choice,
      changeKindConfidence: changeKindDecision.confidence,
      touchesErrorHandlingProb: errHandlingDecision.noul,
      touchesAsyncProb: asyncDecision.noul,
      containsReviewerInstructionsProb: reviewerInstructionsDecision.noul,
      touchesPublicApi: hasPublicApi,
      touchesPublicApiPartial: partial,
      astSkipped,
      requestId: response.requestId,
      latencyMs: response.latencyMs,
      usage: response.usage,
      skippedFromReview,
      containsSecret: false,
      profileFailed: false,
    });
  }

  return {
    hunks: entries,
    injectedInstructionsInDiff: foldInjectedInstructions(entries),
    truncatedHunkCount,
    totalRequests,
    totalLatencyMs,
    totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
