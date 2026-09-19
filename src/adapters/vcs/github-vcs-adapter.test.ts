import { describe, expect, it, vi } from "vitest";
import type { InlineComment, ReviewPublication } from "../../domain/ports/vcs-port.js";
import type { PullRequestRef } from "../../domain/pull-request.js";
import { type GitHubApiClient, createGitHubVcsAdapter } from "./github-vcs-adapter.js";

const REF: PullRequestRef = {
  owner: "tincke10",
  repo: "jevest",
  number: 42,
  headSha: "head-sha",
  baseSha: "base-sha",
};

function ghResponse<T>(
  data: T,
  extra: Partial<{ status: number; headers: Record<string, string> }> = {},
) {
  return { data, status: extra.status ?? 200, headers: extra.headers ?? {} };
}

function githubError(
  status: number,
  headers: Record<string, string> = {},
): Error & { status: number; response: { headers: Record<string, string> } } {
  const error = new Error(`GitHub API error ${status}`) as Error & {
    status: number;
    response: { headers: Record<string, string> };
  };
  error.status = status;
  error.response = { headers };
  return error;
}

function createFakeClient(overrides: Partial<GitHubApiClient> = {}): GitHubApiClient {
  const base: GitHubApiClient = {
    pulls: {
      get: vi.fn().mockResolvedValue(
        ghResponse({
          title: "Add feature",
          body: "Some body",
          user: { login: "octocat" },
          labels: [{ name: "enhancement" }],
          base: { ref: "main", sha: "base-sha" },
          head: { sha: "head-sha" },
        }),
      ),
      listFiles: vi.fn().mockResolvedValue(ghResponse([])),
      listReviewComments: vi.fn().mockResolvedValue(ghResponse([])),
      createReviewComment: vi.fn().mockResolvedValue(ghResponse({ id: 1, body: "" })),
      updateReviewComment: vi.fn().mockResolvedValue(ghResponse({ id: 1, body: "" })),
    },
    issues: {
      listComments: vi.fn().mockResolvedValue(ghResponse([])),
      createComment: vi.fn().mockResolvedValue(ghResponse({ id: 1, body: "" })),
      updateComment: vi.fn().mockResolvedValue(ghResponse({ id: 1, body: "" })),
      getLabel: vi.fn().mockResolvedValue(ghResponse({ name: "jevest:auto-merge-ok" })),
      createLabel: vi.fn().mockResolvedValue(ghResponse({ name: "jevest:auto-merge-ok" })),
      addLabels: vi.fn().mockResolvedValue(ghResponse([])),
      removeLabel: vi.fn().mockResolvedValue(ghResponse({})),
    },
    repos: {
      getCombinedStatusForRef: vi.fn().mockResolvedValue(ghResponse({ state: "success" })),
      createCommitStatus: vi.fn().mockResolvedValue(ghResponse({})),
    },
    checks: {
      create: vi.fn().mockResolvedValue(ghResponse({})),
    },
  };
  return {
    pulls: { ...base.pulls, ...overrides.pulls },
    issues: { ...base.issues, ...overrides.issues },
    repos: { ...base.repos, ...overrides.repos },
    checks: { ...base.checks, ...overrides.checks },
  };
}

const PUBLICATION_BASE: ReviewPublication = {
  summaryMarkdown: "## Jevest review\n\n1 finding published.",
  summaryFingerprint: "sum-1",
  inlineComments: [],
  labelsToAdd: [],
  labelsToRemove: [],
  check: { conclusion: "success", title: "jevest: safe to merge", summary: "no blocking findings" },
};

describe("createGitHubVcsAdapter — fetchPullRequest", () => {
  it("maps PR metadata, labels, files and combined CI status to the contract", async () => {
    const client = createFakeClient({
      pulls: {
        get: vi.fn().mockResolvedValue(
          ghResponse({
            title: "Add feature",
            body: null,
            user: { login: "octocat" },
            labels: ["bug", { name: "enhancement" }],
            base: { ref: "main", sha: "base-sha" },
            head: { sha: "head-sha" },
          }),
        ),
        listFiles: vi.fn().mockResolvedValue(
          ghResponse([
            {
              filename: "src/a.ts",
              status: "modified",
              additions: 3,
              deletions: 1,
              patch: "@@ -1 +1 @@",
            },
            { filename: "src/b.ts", status: "added", additions: 10, deletions: 0 },
            { filename: "src/c.ts", status: "copied", additions: 0, deletions: 0 },
          ]),
        ),
        listReviewComments: vi.fn().mockResolvedValue(ghResponse([])),
        createReviewComment: vi.fn(),
        updateReviewComment: vi.fn(),
      } as unknown as GitHubApiClient["pulls"],
    });

    const adapter = createGitHubVcsAdapter({ client });
    const data = await adapter.fetchPullRequest(REF);

    expect(data.title).toBe("Add feature");
    expect(data.body).toBe("");
    expect(data.author).toBe("octocat");
    expect(data.labels).toEqual(["bug", "enhancement"]);
    expect(data.baseBranch).toBe("main");
    expect(data.ref).toEqual({
      owner: "tincke10",
      repo: "jevest",
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    expect(data.ciStatus).toBe("success");
    expect(data.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
      { path: "src/b.ts", status: "added", additions: 10, deletions: 0 },
      { path: "src/c.ts", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("paginates pulls.listFiles until a short page is returned", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce(ghResponse(fullPage))
      .mockResolvedValueOnce(
        ghResponse([{ filename: "src/last.ts", status: "added", additions: 1, deletions: 0 }]),
      );
    const client = createFakeClient({ pulls: { ...createFakeClient().pulls, listFiles } });

    const adapter = createGitHubVcsAdapter({ client });
    const data = await adapter.fetchPullRequest(REF);

    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(listFiles).toHaveBeenNthCalledWith(1, {
      owner: "tincke10",
      repo: "jevest",
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      owner: "tincke10",
      repo: "jevest",
      pull_number: 42,
      per_page: 100,
      page: 2,
    });
    expect(data.files).toHaveLength(101);
  });

  it("maps failure and unrecognized combined status states", async () => {
    const client = createFakeClient({
      repos: {
        ...createFakeClient().repos,
        getCombinedStatusForRef: vi.fn().mockResolvedValue(ghResponse({ state: "error" })),
      },
    });
    const adapter = createGitHubVcsAdapter({ client });
    const data = await adapter.fetchPullRequest(REF);
    expect(data.ciStatus).toBe("failure");
  });
});

describe("createGitHubVcsAdapter — publishReview inline comments", () => {
  const comment: InlineComment = {
    path: "src/a.ts",
    line: 10,
    body: "Null check missing",
    fingerprint: "fp-1",
  };

  it("creates a new review comment with the fingerprint marker when none exists", async () => {
    const client = createFakeClient();
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, { ...PUBLICATION_BASE, inlineComments: [comment] });

    expect(client.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "tincke10",
        repo: "jevest",
        pull_number: 42,
        commit_id: "head-sha",
        path: "src/a.ts",
        line: 10,
        side: "RIGHT",
        body: expect.stringContaining("<!-- jevest:fp:fp-1 -->"),
      }),
    );
    expect(client.pulls.updateReviewComment).not.toHaveBeenCalled();
  });

  it("updates the existing comment in place instead of duplicating it (NFR-12)", async () => {
    const client = createFakeClient({
      pulls: {
        ...createFakeClient().pulls,
        listReviewComments: vi
          .fn()
          .mockResolvedValue(ghResponse([{ id: 99, body: "old body\n\n<!-- jevest:fp:fp-1 -->" }])),
      },
    });
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, { ...PUBLICATION_BASE, inlineComments: [comment] });

    expect(client.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 99,
        body: expect.stringContaining("<!-- jevest:fp:fp-1 -->"),
      }),
    );
    expect(client.pulls.createReviewComment).not.toHaveBeenCalled();
  });
});

describe("createGitHubVcsAdapter — publishReview summary", () => {
  it("creates the summary comment when none exists", async () => {
    const client = createFakeClient();
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, PUBLICATION_BASE);

    expect(client.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "tincke10",
        repo: "jevest",
        issue_number: 42,
        body: expect.stringContaining("<!-- jevest:summary:sum-1 -->"),
      }),
    );
    expect(client.issues.updateComment).not.toHaveBeenCalled();
  });

  it("upserts the same summary slot even when the fingerprint changed since the last run", async () => {
    const client = createFakeClient({
      issues: {
        ...createFakeClient().issues,
        listComments: vi
          .fn()
          .mockResolvedValue(
            ghResponse([{ id: 7, body: "old summary\n\n<!-- jevest:summary:old-fp -->" }]),
          ),
      },
    });
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, PUBLICATION_BASE);

    expect(client.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 7,
        body: expect.stringContaining("<!-- jevest:summary:sum-1 -->"),
      }),
    );
    expect(client.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("createGitHubVcsAdapter — publishReview labels", () => {
  it("creates a missing label before adding it, and adds all requested labels in one call", async () => {
    const getLabel = vi.fn().mockRejectedValue(githubError(404));
    const createLabel = vi.fn().mockResolvedValue(ghResponse({ name: "jevest:auto-merge-ok" }));
    const addLabels = vi.fn().mockResolvedValue(ghResponse([]));
    const client = createFakeClient({
      issues: { ...createFakeClient().issues, getLabel, createLabel, addLabels },
    });
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, {
      ...PUBLICATION_BASE,
      labelsToAdd: ["jevest:auto-merge-ok"],
    });

    expect(createLabel).toHaveBeenCalledWith({
      owner: "tincke10",
      repo: "jevest",
      name: "jevest:auto-merge-ok",
    });
    expect(addLabels).toHaveBeenCalledWith({
      owner: "tincke10",
      repo: "jevest",
      issue_number: 42,
      labels: ["jevest:auto-merge-ok"],
    });
  });

  it("does not create a label that already exists", async () => {
    const getLabel = vi.fn().mockResolvedValue(ghResponse({ name: "jevest:auto-merge-ok" }));
    const createLabel = vi.fn();
    const client = createFakeClient({
      issues: { ...createFakeClient().issues, getLabel, createLabel },
    });
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, {
      ...PUBLICATION_BASE,
      labelsToAdd: ["jevest:auto-merge-ok"],
    });

    expect(createLabel).not.toHaveBeenCalled();
  });

  it("ignores a 404 when removing a label that is already absent", async () => {
    const removeLabel = vi.fn().mockRejectedValue(githubError(404));
    const client = createFakeClient({ issues: { ...createFakeClient().issues, removeLabel } });
    const adapter = createGitHubVcsAdapter({ client });

    await expect(
      adapter.publishReview(REF, { ...PUBLICATION_BASE, labelsToRemove: ["jevest:auto-merge-ok"] }),
    ).resolves.toBeUndefined();
  });

  it("propagates a non-404 error when removing a label", async () => {
    const removeLabel = vi.fn().mockRejectedValue(githubError(500));
    const client = createFakeClient({ issues: { ...createFakeClient().issues, removeLabel } });
    const adapter = createGitHubVcsAdapter({ client });

    await expect(
      adapter.publishReview(REF, { ...PUBLICATION_BASE, labelsToRemove: ["jevest:auto-merge-ok"] }),
    ).rejects.toThrow();
  });
});

describe("createGitHubVcsAdapter — publishReview check", () => {
  it("creates a GitHub check with the mapped conclusion", async () => {
    const client = createFakeClient();
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, {
      ...PUBLICATION_BASE,
      check: {
        conclusion: "neutral",
        title: "jevest: needs review",
        summary: "1 medium-band finding",
      },
    });

    expect(client.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "tincke10",
        repo: "jevest",
        name: "jevest",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "neutral",
      }),
    );
    expect(client.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it("falls back to the legacy commit-status API when checks:write is forbidden", async () => {
    const create = vi.fn().mockRejectedValue(githubError(403));
    const createCommitStatus = vi.fn().mockResolvedValue(ghResponse({}));
    const client = createFakeClient({
      checks: { create },
      repos: { ...createFakeClient().repos, createCommitStatus },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = createGitHubVcsAdapter({ client });

    await adapter.publishReview(REF, {
      ...PUBLICATION_BASE,
      check: {
        conclusion: "failure",
        title: "jevest: blocking finding",
        summary: "1 critical finding",
      },
    });

    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "tincke10",
        repo: "jevest",
        sha: "head-sha",
        state: "failure",
        context: "jevest",
      }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never calls a merge endpoint (FR-6.4): the injected client has no such method", () => {
    const client = createFakeClient();
    expect((client as unknown as Record<string, unknown>).merge).toBeUndefined();
    expect((client.pulls as unknown as Record<string, unknown>).merge).toBeUndefined();
  });
});

describe("createGitHubVcsAdapter — rate-limit backoff", () => {
  it("retries a 429 with the injectable sleep and succeeds", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(githubError(429, { "retry-after": "1" }))
      .mockResolvedValue(
        ghResponse({
          title: "Add feature",
          body: "body",
          user: { login: "octocat" },
          labels: [],
          base: { ref: "main", sha: "base-sha" },
          head: { sha: "head-sha" },
        }),
      );
    const client = createFakeClient({ pulls: { ...createFakeClient().pulls, get } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createGitHubVcsAdapter({ client, sleep, maxRetries: 3 });

    const data = await adapter.fetchPullRequest(REF);

    expect(get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(data.title).toBe("Add feature");
  });

  it("does not retry a 403 permission error (no rate-limit headers) before falling back", async () => {
    const create = vi.fn().mockRejectedValue(githubError(403));
    const createCommitStatus = vi.fn().mockResolvedValue(ghResponse({}));
    const client = createFakeClient({
      checks: { create },
      repos: { ...createFakeClient().repos, createCommitStatus },
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createGitHubVcsAdapter({ client, sleep, maxRetries: 3 });

    await adapter.publishReview(REF, PUBLICATION_BASE);

    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries on a persistent 429", async () => {
    const get = vi.fn().mockRejectedValue(githubError(429, { "retry-after": "0" }));
    const client = createFakeClient({ pulls: { ...createFakeClient().pulls, get } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createGitHubVcsAdapter({ client, sleep, maxRetries: 2 });

    await expect(adapter.fetchPullRequest(REF)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(3);
  });
});
