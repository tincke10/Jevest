/**
 * Stage 2: hunk profile (SPEC FR-3, §4.3 provisional split). Jev answers
 * only `change_kind`, `touches_error_handling`, and `touches_async` per
 * hunk (§4.3: `touches_public_api` is derived in code by AST, since the
 * `export` line is often outside the hunk; `touches_io` is dropped until
 * there's more labeled support). One Jev request per hunk (NFR-14) — the
 * question wording is reused verbatim from `question-sets/profile.ts`.
 * These three Jev questions run on the raw diff for ANY language — the
 * language gate below applies only to the AST-based `touchesPublicApi`.
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
import { profileQuestionSet } from "../../spike/question-sets/profile.js";
import type { RiskLevel } from "./triage.js";

const PIPELINE_PROFILE_QUESTION_NAMES = ["change_kind", "touches_error_handling", "touches_async"];
const pipelineProfileQuestions = profileQuestionSet.questions.filter((q) =>
  PIPELINE_PROFILE_QUESTION_NAMES.includes(q.name),
);

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
    if (
      changeKindDecision?.type !== "choice" ||
      errHandlingDecision?.type !== "noul" ||
      asyncDecision?.type !== "noul"
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
    truncatedHunkCount,
    totalRequests,
    totalLatencyMs,
    totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
