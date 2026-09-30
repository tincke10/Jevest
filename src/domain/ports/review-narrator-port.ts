/**
 * Port for the review narrator: one LLM call per pull request, AFTER the
 * finding filter, that turns what Jev kept into the review a senior
 * colleague would write — an overall take, the concrete points tied to
 * `file:line`, and a verdict line. Zero SDK imports; adapters live in
 * src/adapters/narrators/.
 *
 * The narrator is a WRITER, never a reviewer. It receives only the findings
 * Jev kept for publishing (and the needs-human ones, marked as such); the
 * diff is there for context and phrasing, and the prompt forbids raising
 * anything that is not in `findings`. Handing it the reviewer's raw output
 * instead would let it undo the filter, which is the whole point of Jevest.
 */
import type { FindingSeverity } from "../finding.js";
import type { ReviewUsage } from "./reviewer-port.js";

/** One finding as the narrator sees it: already filtered by Jev, located on the HEAD side. */
export interface NarratedFinding {
  readonly file: string;
  /** HEAD-side line, the one a reader of the PR sees (not the reviewer's before-side line). */
  readonly line: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
  /** Jev's severity, as a word. */
  readonly severity: FindingSeverity;
  /** True when Jev was not confident enough to publish it: to be phrased as a question, not an assertion. */
  readonly needsHuman: boolean;
}

/** One hunk the LLM reviewer actually reviewed (context only). */
export interface NarratedHunk {
  readonly file: string;
  readonly hunkHeader: string;
  readonly diff: string;
}

/** The verdict the check carries, in words; the narrator's closing line must agree with it. */
export type NarrativeVerdict = "ready-to-merge" | "needs-changes" | "needs-human-look";

export interface ReviewNarrativeInput {
  /** `${owner}/${repo}#${number}`; for error messages and fixtures only. */
  readonly prId: string;
  readonly title: string;
  readonly description: string;
  readonly changedFiles: readonly string[];
  readonly hunks: readonly NarratedHunk[];
  readonly findings: readonly NarratedFinding[];
  /** `reviewer.language` from `.jevest.yml`, e.g. "es" or "en". */
  readonly language: string;
  readonly verdict: NarrativeVerdict;
}

export interface ReviewNarrativeOutput {
  /** The review body, markdown, without a top-level heading. */
  readonly markdown: string;
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /** See `ReviewOutput.nominalCostUsd`: set only by adapters billed outside per-token pricing. */
  readonly nominalCostUsd?: number;
  /** See `ReviewOutput.sessionId`: debugging only, never persisted. */
  readonly sessionId?: string;
}

export interface ReviewNarratorPort {
  narrate(input: ReviewNarrativeInput): Promise<ReviewNarrativeOutput>;
}
