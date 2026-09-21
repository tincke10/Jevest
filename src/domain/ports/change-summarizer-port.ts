/**
 * Port for the LLM change summarizer of the intent–change coherence spike
 * (H7, SPEC §4.2): given a pull request's files and diffs, describe WHAT
 * changes at the product/behavior level. Zero SDK imports; adapters live in
 * src/adapters/summarizers/.
 *
 * The input deliberately carries NO title, body or labels, and the port has
 * no way to receive them. Two reasons, both non-negotiable:
 *
 * 1. Experiment integrity. H7's ground truth is built by crossing
 *    descriptions (a PR's change paired with ANOTHER PR's description). If
 *    the summarizer saw the description, its summary would echo whichever
 *    narrative it was shown and the "does the description match the change"
 *    question would be answered by contamination, not by the change.
 * 2. Production semantics. The summary is meant to be an independent
 *    reading of the diff, so that Jev can compare the author's story with
 *    what the code actually does. A summary that paraphrases the author's
 *    story has zero evidential value.
 */
import type { ReviewUsage } from "./reviewer-port.js";

/**
 * One changed file as the summarizer sees it. Structurally identical to
 * `PrFile` in src/application/coherence/pr-record.ts, redeclared here so the
 * domain never imports from the application layer.
 */
export interface SummarizedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  /** Unified diff; absent for binary files or when the VCS returned no patch. */
  readonly patch?: string;
}

export interface ChangeSummaryInput {
  /** `${repo}#${number}`; used only as a correlation/fixture key, never shown as content. */
  readonly prId: string;
  readonly files: readonly SummarizedFile[];
}

/** camelCase mirror of the snake_case structured output the model produces. */
export interface ChangeSummary {
  /** What the change does, at product/behavior level, in at most ~60 words. */
  readonly whatChanges: string;
  /** Up to ~5 short observable behavior changes; empty when nothing observable changes. */
  readonly behaviorChanges: readonly string[];
  /** True only if an end user or API consumer could observe a difference. */
  readonly userFacing: boolean;
  /** True only if existing callers or users must change something. */
  readonly breaking: boolean;
  /** Product areas in plain words (not file paths). */
  readonly areas: readonly string[];
  /** Up to ~4 risks; empty allowed. */
  readonly risks: readonly string[];
}

export interface ChangeSummaryOutput {
  readonly summary: ChangeSummary;
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /** See `ReviewOutput.nominalCostUsd`: set only by adapters billed outside per-token pricing. */
  readonly nominalCostUsd?: number;
  /**
   * See `ReviewOutput.sessionId`: set only by session-oriented CLI adapters,
   * for debugging only. Never persist it (recorded-summarizer.ts strips it).
   */
  readonly sessionId?: string;
}

export interface ChangeSummarizerPort {
  summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput>;
}
