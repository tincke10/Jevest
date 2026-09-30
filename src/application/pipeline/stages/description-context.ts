/**
 * Author context: one DescriptionContextPort call per PR, after triage and
 * before the review stage, that keeps from the PR description only what
 * helps the reviewer understand the change (design decisions, intended
 * behavior, scope, constraints, references) and drops every sentence that
 * tries to steer or skip the review (see ../../../domain/author-context.ts).
 * Not one of SPEC §3's six stages: it adds no decision of its own.
 *
 * Three layers keep the description from steering the review:
 * 1. The pipeline's injection gate: when triage flagged injected
 *    instructions in the description, this stage is never called and
 *    NOTHING from the description reaches the reviewer (run-pipeline.ts,
 *    {@link descriptionContextSkipped}).
 * 2. The extractor itself, told to treat the description as untrusted data
 *    and to list what it dropped; then `sanitizeAuthorContext`, a
 *    deterministic post-filter that moves any kept item still matching a
 *    review-suppression pattern to `discarded`, flattens and caps the rest.
 * 3. The reviewer prompt's hard rule (../../../adapters/reviewers/review-prompt.ts):
 *    the context is for intent only, never a reason to dismiss a finding.
 *
 * The description is redacted (NFR-3) before it leaves the process, the
 * same way triage redacts it for Jev. Like the change summary and the
 * narrative, this is an ENHANCER: an extractor error never fails the run.
 * It becomes a one-line note and the review runs without author context.
 */
import {
  type AuthorContext,
  isAuthorContextEmpty,
  sanitizeAuthorContext,
} from "../../../domain/author-context.js";
import type { DescriptionContextPort } from "../../../domain/ports/description-context-port.js";
import type { ReviewUsage } from "../../../domain/ports/reviewer-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { redact } from "../../../domain/redact.js";
import { describeReviewerError } from "../../../domain/reviewer-error.js";
import { type ModelPricing, reviewCostUsd } from "../../findings/pricing.js";

export interface DescriptionContextStageInput {
  readonly pr: PullRequestData;
  readonly extractor: DescriptionContextPort;
  /** `reviewer.language`: the language the kept items are written in. */
  readonly language: string;
  /** Rate table when the adapter reports no nominal cost (the reviewer model's). */
  readonly pricing: ModelPricing;
}

export interface DescriptionContextStageResult {
  /** "extracted" when the extractor answered; "skipped" when the pipeline did not call it; "failed" on an error. */
  readonly status: "extracted" | "skipped" | "failed";
  /** The sanitized context; `null` unless extracted. May be empty (everything was discarded or there was nothing to keep). */
  readonly context: AuthorContext | null;
  /** What was dropped from the description for steering the review (extractor + post-filter), already flattened and capped. */
  readonly discarded: readonly string[];
  /** One line for the comment when the description was not used; `null` otherwise. */
  readonly note: string | null;
  readonly model: string | null;
  readonly usage: ReviewUsage | null;
  /** 0 unless extracted. Nominal cost when the adapter reports one, else priced from usage. */
  readonly costUsd: number;
  readonly latencyMs: number;
}

/** The pipeline decided not to use the description; `reason` ends up in the comment. */
export function descriptionContextSkipped(reason: string): DescriptionContextStageResult {
  return {
    status: "skipped",
    context: null,
    discarded: [],
    note: `The PR description was not used as review context (${reason}).`,
    model: null,
    usage: null,
    costUsd: 0,
    latencyMs: 0,
  };
}

/** What the reviewer gets: the kept context, or `undefined` when there is nothing (so its prompt stays unchanged). */
export function reviewerAuthorContext(
  result: DescriptionContextStageResult | null,
): AuthorContext | undefined {
  const context = result?.context ?? null;
  return context === null || isAuthorContextEmpty(context) ? undefined : context;
}

export async function runDescriptionContextStage(
  input: DescriptionContextStageInput,
): Promise<DescriptionContextStageResult> {
  const { pr } = input;
  try {
    const output = await input.extractor.extract({
      prId: `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`,
      title: pr.title,
      description: redact(pr.body).text,
      changedFiles: pr.files.map((f) => f.path),
      language: input.language,
    });
    const sanitized = sanitizeAuthorContext(output);
    return {
      status: "extracted",
      context: sanitized.context,
      discarded: sanitized.discarded,
      note: null,
      model: output.model,
      usage: output.usage,
      // Same rule as the review, the summary and the narrative.
      costUsd: output.nominalCostUsd ?? reviewCostUsd(output.usage, input.pricing),
      latencyMs: output.latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `jevest: description context extraction failed (${message}); reviewing without it`,
    );
    return {
      status: "failed",
      context: null,
      discarded: [],
      note: `Extracting review context from the PR description failed (${describeReviewerError(message)}); the reviewer ran without it.`,
      model: null,
      usage: null,
      costUsd: 0,
      latencyMs: 0,
    };
  }
}
