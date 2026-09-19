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

export interface ReviewPublication {
  summaryMarkdown: string;
  summaryFingerprint: string;
  inlineComments: InlineComment[];
  labelsToAdd: string[];
  labelsToRemove: string[];
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
