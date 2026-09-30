/**
 * Port for fetching a PR and publishing a review (SPEC §7, FR-6.4, FR-7).
 * Copied verbatim from the cross-agent shared contract — the GitHub
 * adapter (github agent) and the local-diff adapter (mine) both implement
 * this exact shape. Zero SDK imports: adapters implement it.
 */
import type { PullRequestData, PullRequestRef } from "../pull-request.js";

export interface InlineComment {
  path: string;
  /** Absolute line on the HEAD (after) side. */
  line: number;
  body: string;
  /** Stable id; adapters use it for idempotent upsert (NFR-12). */
  fingerprint: string;
}

/** How a label should look when an adapter has to create it (GitHub: color without `#`, description <= 100 chars). */
export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface ReviewPublication {
  summaryMarkdown: string;
  summaryFingerprint: string;
  inlineComments: InlineComment[];
  labelsToAdd: string[];
  labelsToRemove: string[];
  /**
   * Color and description for labels in `labelsToAdd` that should look a
   * certain way. An adapter creates a missing label with these; a label
   * that already exists is left as the repo has it. Labels not listed here
   * are created bare, as before.
   */
  labelDefinitions?: LabelDefinition[];
  check: {
    conclusion: "success" | "neutral" | "failure";
    title: string;
    summary: string;
  };
}

export interface VcsPort {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequestData>;
  publishReview(ref: PullRequestRef, publication: ReviewPublication): Promise<void>;
}
