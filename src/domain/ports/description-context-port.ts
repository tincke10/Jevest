/**
 * Port for the description-context extractor: one LLM call per pull
 * request, after triage and before the review stage, that reads the PR
 * title and description and keeps ONLY what helps a reviewer understand
 * the change (see ../author-context.ts). Zero SDK imports; adapters live
 * in src/adapters/description-context/.
 *
 * The description is untrusted, author-controlled text. The extractor's
 * job is as much to drop as to keep: every sentence that tries to steer or
 * skip the review, or asserts quality as a reason to trust the code, goes
 * to `discarded` instead of `context`. The pipeline never trusts the
 * adapter alone on that: `sanitizeAuthorContext` re-checks every kept item
 * deterministically before anything reaches the reviewer.
 */
import type { AuthorContext } from "../author-context.js";
import type { ReviewUsage } from "./reviewer-port.js";

export interface DescriptionContextInput {
  /** `${owner}/${repo}#${number}`; for error messages and fixtures only, never shown to the model. */
  readonly prId: string;
  readonly title: string;
  /** Already redacted (NFR-3) by the caller. */
  readonly description: string;
  readonly changedFiles: readonly string[];
  /** `reviewer.language`: the language the items are written in. */
  readonly language: string;
}

export interface DescriptionContextOutput {
  /** What was kept, as the model returned it (the stage sanitizes it). */
  readonly context: AuthorContext;
  /** Short paraphrases of every sentence dropped for steering the review. */
  readonly discarded: readonly string[];
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /** See `ReviewOutput.nominalCostUsd`: set only by adapters billed outside per-token pricing. */
  readonly nominalCostUsd?: number;
  /** See `ReviewOutput.sessionId`: debugging only, never persisted. */
  readonly sessionId?: string;
}

export interface DescriptionContextPort {
  extract(input: DescriptionContextInput): Promise<DescriptionContextOutput>;
}
