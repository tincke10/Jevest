import { describe, expect, it } from "vitest";
import type { ReviewPublication } from "../../domain/ports/vcs-port.js";
import type { PullRequestData } from "../../domain/pull-request.js";
import { createInMemoryVcsAdapter } from "./in-memory-vcs-adapter.js";

const pr: PullRequestData = {
  ref: { owner: "acme", repo: "widgets", number: 1, headSha: "head", baseSha: "base" },
  title: "t",
  body: "b",
  author: "dev",
  labels: [],
  baseBranch: "main",
  files: [],
  ciStatus: "success",
};

const publication: ReviewPublication = {
  summaryMarkdown: "## Jevest review",
  summaryFingerprint: "abc",
  inlineComments: [],
  labelsToAdd: [],
  labelsToRemove: [],
  check: { conclusion: "failure", title: "Jevest: failure", summary: "s" },
};

describe("createInMemoryVcsAdapter", () => {
  it("serves the given PR for any ref and captures every publication in order", async () => {
    const { vcs, published } = createInMemoryVcsAdapter(pr);
    await expect(vcs.fetchPullRequest(pr.ref)).resolves.toBe(pr);
    expect(published).toEqual([]);

    await vcs.publishReview(pr.ref, publication);
    await vcs.publishReview(pr.ref, { ...publication, summaryFingerprint: "def" });

    expect(published).toHaveLength(2);
    expect(published[0]).toBe(publication);
    expect(published[1]!.summaryFingerprint).toBe("def");
  });
});
