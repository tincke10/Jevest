/**
 * Stage 3, agentic mode (`reviewer.mode: agentic`): ONE read-only agent
 * per pull request in a checkout of the PR head, in place of the per-hunk
 * review and the code-context stage. What it gets: the redacted title, the
 * author context (extracted when the description-context stage ran,
 * otherwise the redacted description framed as untrusted data, never
 * either when triage flagged injected instructions), every changed path,
 * and the redacted diff capped at {@link AGENTIC_MAX_DIFF_CHARS} (whole
 * files are left out past the cap, and the prompt says which, so the agent
 * can open them itself).
 *
 * Fail closed, never fall back: without a checkout the agent cannot run,
 * and the stage reports `unavailable` instead of silently reviewing per
 * hunk. Like an agent error, it is recorded on every reviewable hunk, so
 * the verdict is `unavailable` (all reviews failed, NFR-2), nothing is
 * marked safe to auto-merge, and the comment's "LLM review failed" section
 * carries the one-line reason.
 *
 * The run is booked on the reviewable hunks (`review`): one entry per hunk
 * the hunk profile did not skip, the first one carrying the agent's usage
 * and cost, so the verdict, the narrator (which shows the reviewed hunks)
 * and the run metrics work unchanged. The findings themselves are judged
 * by agentic-judge.ts.
 */
import type { AgenticFinding } from "../../../domain/agentic-finding.js";
import type { AuthorContext } from "../../../domain/author-context.js";
import type {
  AgentRunInfo,
  AgenticReviewInput,
  AgenticReviewerPort,
} from "../../../domain/ports/agentic-reviewer-port.js";
import type { PullRequestData, PullRequestFile } from "../../../domain/pull-request.js";
import { redact } from "../../../domain/redact.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";
import type { ReviewStageEntry, ReviewStageResult } from "./review.js";

/** Diff characters sent to the agent; past this, whole files are left out (it can Read them). */
export const AGENTIC_MAX_DIFF_CHARS = 120_000;

/** The one-line reason when there is no checkout; the reason follows a colon. */
export const AGENTIC_UNAVAILABLE_PREFIX = "agentic review unavailable";

export interface AgenticDiff {
  readonly diff: string;
  /** What the cap cut, for the prompt; absent when nothing was cut. */
  readonly note?: string;
  readonly omittedFiles: readonly string[];
}

/** The redacted unified diff of every file, whole files left out past `maxChars` (see the module doc). */
export function buildAgenticDiff(files: readonly PullRequestFile[], maxChars: number): AgenticDiff {
  const parts: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;
  for (const f of files) {
    const header = `diff --git a/${f.path} b/${f.path}`;
    const body =
      f.patch === undefined || f.patch === ""
        ? `(no textual diff: binary or too large; status ${f.status})`
        : redact(f.patch, { path: f.path }).text;
    const part = `${header}\n${body}`;
    if (used + part.length > maxChars) {
      omittedFiles.push(f.path);
      continue;
    }
    parts.push(part);
    used += part.length + 1;
  }
  if (omittedFiles.length === 0) return { diff: parts.join("\n"), omittedFiles };
  const listed = omittedFiles.slice(0, 20).join(", ");
  const more = omittedFiles.length > 20 ? ` and ${omittedFiles.length - 20} more` : "";
  return {
    diff: parts.join("\n"),
    note: `${omittedFiles.length} file${omittedFiles.length === 1 ? "" : "s"} left out by the size cap (${listed}${more}); open them with Read`,
    omittedFiles,
  };
}

export type AgenticReviewStatus =
  | "ran"
  | "failed"
  | "unavailable"
  | "skipped-budget"
  | "nothing-to-review";

export interface AgenticReviewStageInput {
  readonly pr: PullRequestData;
  readonly hunkProfile: HunkProfileStageResult;
  /** Required for the agent to run; the pipeline checks it is wired in agentic mode. */
  readonly reviewer: AgenticReviewerPort;
  /** The checkout of the PR head; absent = unavailable. */
  readonly repoRoot?: string | undefined;
  /** Why there is no checkout, for the note. Default "no checkout". */
  readonly unavailableReason?: string | undefined;
  readonly authorContext?: AuthorContext | undefined;
  /** The raw description, used (redacted) only when there is no author context. */
  readonly description?: string | undefined;
  /** What is left of the per-run budget; the agent does not start at 0. */
  readonly budgetUsd: number;
  readonly maxDiffChars?: number;
}

export interface AgenticReviewStageResult {
  readonly status: AgenticReviewStatus;
  /** Why the agent did not answer (`unavailable`, `failed`); `null` otherwise. */
  readonly error: string | null;
  readonly findings: readonly AgenticFinding[];
  /** Model, usage, latency, cost, turns and tool calls of the run; `null` when it did not answer. */
  readonly info: AgentRunInfo | null;
  readonly costUsd: number;
  readonly diffChars: number;
  readonly omittedFiles: readonly string[];
  /** The run booked on the reviewable hunks (see the module doc). */
  readonly review: ReviewStageResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedEntries(hunks: readonly HunkProfileEntry[], error: string): ReviewStageEntry[] {
  return hunks.map((h) => ({
    hunkId: h.id,
    file: h.file,
    findings: [],
    model: null,
    usage: null,
    latencyMs: 0,
    requestId: undefined,
    costUsd: 0,
    error,
  }));
}

function bookedEntries(hunks: readonly HunkProfileEntry[], info: AgentRunInfo): ReviewStageEntry[] {
  return hunks.map((h, index) => ({
    hunkId: h.id,
    file: h.file,
    findings: [],
    model: info.model,
    usage: index === 0 ? info.usage : null,
    latencyMs: index === 0 ? info.latencyMs : 0,
    requestId: undefined,
    costUsd: index === 0 ? info.nominalCostUsd : 0,
    error: null,
  }));
}

const EMPTY_REVIEW: ReviewStageResult = {
  reviews: [],
  totalCostUsd: 0,
  budgetExceeded: false,
  skippedForBudgetCount: 0,
};

export async function runAgenticReviewStage(
  input: AgenticReviewStageInput,
): Promise<AgenticReviewStageResult> {
  const eligible = input.hunkProfile.hunks.filter((h) => !h.skippedFromReview);
  const { diff, note, omittedFiles } = buildAgenticDiff(
    input.pr.files,
    input.maxDiffChars ?? AGENTIC_MAX_DIFF_CHARS,
  );
  const nothing = {
    findings: [],
    info: null,
    costUsd: 0,
    diffChars: diff.length,
    omittedFiles,
  };

  if (eligible.length === 0) {
    return { ...nothing, status: "nothing-to-review", error: null, review: EMPTY_REVIEW };
  }
  if (input.repoRoot === undefined) {
    const error = `${AGENTIC_UNAVAILABLE_PREFIX}: ${input.unavailableReason ?? "no checkout"} (agentic mode needs a checkout of the PR head)`;
    return {
      ...nothing,
      status: "unavailable",
      error,
      review: { ...EMPTY_REVIEW, reviews: failedEntries(eligible, error) },
    };
  }
  if (input.budgetUsd <= 0) {
    return {
      ...nothing,
      status: "skipped-budget",
      error: null,
      review: { ...EMPTY_REVIEW, budgetExceeded: true, skippedForBudgetCount: eligible.length },
    };
  }

  const { pr } = input;
  const description =
    input.authorContext === undefined && input.description !== undefined
      ? redact(input.description).text
      : undefined;
  const request: AgenticReviewInput = {
    prId: `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`,
    repoRoot: input.repoRoot,
    title: redact(pr.title).text,
    ...(input.authorContext !== undefined ? { authorContext: input.authorContext } : {}),
    ...(description !== undefined && description.trim() !== "" ? { description } : {}),
    changedFiles: pr.files.map((f) => f.path),
    diff,
    ...(note !== undefined ? { diffNote: note } : {}),
  };

  try {
    const output = await input.reviewer.reviewPullRequest(request);
    const { findings, ...info } = output;
    return {
      ...nothing,
      status: "ran",
      error: null,
      findings,
      info,
      costUsd: info.nominalCostUsd,
      review: {
        reviews: bookedEntries(eligible, info),
        totalCostUsd: info.nominalCostUsd,
        budgetExceeded: false,
        skippedForBudgetCount: 0,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`jevest: agentic review failed (${message})`);
    return {
      ...nothing,
      status: "failed",
      error: message,
      review: { ...EMPTY_REVIEW, reviews: failedEntries(eligible, message) },
    };
  }
}
