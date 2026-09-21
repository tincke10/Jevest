/**
 * VcsPort that serves one in-memory `PullRequestData` and captures every
 * publication instead of writing anywhere (SPEC §10.2 fake pattern). Used
 * by the adversarial suite, where each case IS the pull request and the
 * assertions run over what would have been published — no disk, no API.
 */
import type { ReviewPublication, VcsPort } from "../../domain/ports/vcs-port.js";
import type { PullRequestData, PullRequestRef } from "../../domain/pull-request.js";

export interface InMemoryVcsAdapter {
  readonly vcs: VcsPort;
  /** Every publication passed to `publishReview`, in call order. */
  readonly published: ReviewPublication[];
}

export function createInMemoryVcsAdapter(pr: PullRequestData): InMemoryVcsAdapter {
  const published: ReviewPublication[] = [];
  return {
    published,
    vcs: {
      async fetchPullRequest(_ref: PullRequestRef): Promise<PullRequestData> {
        return pr;
      },
      async publishReview(_ref: PullRequestRef, publication: ReviewPublication): Promise<void> {
        published.push(publication);
      },
    },
  };
}
