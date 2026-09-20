import type { InlineComment, ReviewPublication, VcsPort } from "../../domain/ports/vcs-port.js";
/**
 * VcsPort over `@octokit/rest` (SPEC §5 Fase 2, FR-6.4, FR-7, NFR-12). Zero
 * GitHub SDK imports outside this file and src/action/** (hexagonal
 * boundary). The Octokit client is always injected (`options.client`),
 * narrowed to the subset of methods this adapter calls — same pattern as
 * `DecisionApiClient` in ../typesafe-decision-adapter.ts and
 * `AnthropicMessagesClient` in ../reviewers/anthropic-reviewer.ts — so tests
 * never touch the real SDK and a real `Octokit` instance satisfies the
 * narrower type structurally.
 *
 * Idempotency (NFR-12): inline comments are matched by an exact fingerprint
 * marker (`<!-- jevest:fp:<fingerprint> -->`) so re-publishing the SAME
 * finding updates its existing comment instead of duplicating it, while a
 * genuinely new finding gets a new comment. The summary comment is matched
 * by the marker PREFIX only (`<!-- jevest:summary:`), not the exact
 * fingerprint value, because the summary's content (and therefore its
 * fingerprint) legitimately changes on every run — there is always at most
 * one summary comment per PR, and this adapter always updates that same
 * slot in place.
 *
 * This adapter never calls any merge endpoint (FR-6.4): `GitHubApiClient`
 * below has no `merge` method, so calling it is a compile error, not just a
 * convention.
 */
import type { PullRequestData, PullRequestRef } from "../../domain/pull-request.js";

/** Minimal shape of an Octokit REST response this adapter reads from. */
interface GhResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Record<string, string | number | undefined>;
}

interface PullGetData {
  readonly title: string;
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
  readonly labels: ReadonlyArray<{ readonly name: string } | string>;
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: { readonly sha: string };
}

interface PullFileData {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

interface ReviewCommentData {
  readonly id: number;
  readonly body?: string;
}

interface IssueCommentData {
  readonly id: number;
  readonly body?: string;
}

interface CombinedStatusData {
  readonly state: string;
}

/** The subset of the Octokit REST client this adapter depends on. */
export interface GitHubApiClient {
  readonly pulls: {
    get(params: { owner: string; repo: string; pull_number: number }): Promise<
      GhResponse<PullGetData>
    >;
    listFiles(params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }): Promise<GhResponse<PullFileData[]>>;
    listReviewComments(params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }): Promise<GhResponse<ReviewCommentData[]>>;
    createReviewComment(params: {
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }): Promise<GhResponse<ReviewCommentData>>;
    updateReviewComment(params: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<GhResponse<ReviewCommentData>>;
  };
  readonly issues: {
    listComments(params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page: number;
      page: number;
    }): Promise<GhResponse<IssueCommentData[]>>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<GhResponse<IssueCommentData>>;
    updateComment(params: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<GhResponse<IssueCommentData>>;
    getLabel(params: { owner: string; repo: string; name: string }): Promise<
      GhResponse<{ name: string }>
    >;
    createLabel(params: {
      owner: string;
      repo: string;
      name: string;
    }): Promise<GhResponse<{ name: string }>>;
    addLabels(params: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<GhResponse<unknown>>;
    removeLabel(params: {
      owner: string;
      repo: string;
      issue_number: number;
      name: string;
    }): Promise<GhResponse<unknown>>;
  };
  readonly repos: {
    getCombinedStatusForRef(params: {
      owner: string;
      repo: string;
      ref: string;
    }): Promise<GhResponse<CombinedStatusData>>;
    createCommitStatus(params: {
      owner: string;
      repo: string;
      sha: string;
      state: "error" | "failure" | "pending" | "success";
      context: string;
      description?: string;
    }): Promise<GhResponse<unknown>>;
  };
  readonly checks: {
    create(params: {
      owner: string;
      repo: string;
      name: string;
      head_sha: string;
      status: "completed";
      conclusion: "success" | "neutral" | "failure";
      output: { title: string; summary: string };
    }): Promise<GhResponse<unknown>>;
  };
}

export interface GitHubVcsAdapterOptions {
  readonly client: GitHubApiClient;
  /** Maximum retries after the initial attempt on 429 / rate-limited 403. Default 3. */
  readonly maxRetries?: number;
  /** Injectable for deterministic tests. Default: real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, used to turn `x-ratelimit-reset` into a delay. Default: `Date.now`. */
  readonly now?: () => number;
}

const PER_PAGE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const FALLBACK_STATUS_CONTEXT = "jevest";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GithubApiError {
  readonly status: number;
  readonly response?: { readonly headers?: Record<string, string | number | undefined> };
}

function isGithubApiError(error: unknown): error is GithubApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}

function headerFor(error: GithubApiError, name: string): string | undefined {
  const value = error.response?.headers?.[name];
  return value === undefined ? undefined : String(value);
}

/** 429 always; 403 only when GitHub's own headers say it's a rate limit, never a plain permission denial. */
function isRateLimited(error: GithubApiError): boolean {
  if (error.status === 429) {
    return true;
  }
  if (error.status !== 403) {
    return false;
  }
  return (
    headerFor(error, "retry-after") !== undefined ||
    headerFor(error, "x-ratelimit-remaining") === "0"
  );
}

function retryDelayMs(error: GithubApiError, now: () => number): number {
  const retryAfter = headerFor(error, "retry-after");
  if (retryAfter !== undefined) {
    return Number(retryAfter) * 1000;
  }
  const reset = headerFor(error, "x-ratelimit-reset");
  if (reset !== undefined) {
    return Math.max(0, Number(reset) * 1000 - now());
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function isNotFound(error: unknown): boolean {
  return isGithubApiError(error) && error.status === 404;
}

function isPermissionDenied(error: unknown): boolean {
  return isGithubApiError(error) && error.status === 403 && !isRateLimited(error);
}

function fingerprintMarker(fingerprint: string): string {
  return `<!-- jevest:fp:${fingerprint} -->`;
}

function summaryMarkerPrefix(): string {
  return "<!-- jevest:summary:";
}

function summaryMarker(fingerprint: string): string {
  return `${summaryMarkerPrefix()}${fingerprint} -->`;
}

function toPullRequestFileStatus(status: string): "added" | "modified" | "removed" | "renamed" {
  switch (status) {
    case "added":
    case "removed":
    case "renamed":
      return status;
    default:
      // "modified", "copied", "changed", "unchanged" and any future GitHub
      // status all collapse to "modified" — the contract has no slot for them.
      return "modified";
  }
}

function toCiStatus(state: string): "success" | "failure" | "pending" | "unknown" {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

function toCommitStatusState(
  conclusion: "success" | "neutral" | "failure",
): "success" | "failure" | "pending" {
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "neutral":
      // The legacy commit-status API has no "neutral" state; a check asking
      // for human confirmation degrades to "pending" rather than a false green.
      return "pending";
  }
}

export function createGitHubVcsAdapter(options: GitHubVcsAdapterOptions): VcsPort {
  const client = options.client;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!isGithubApiError(error) || !isRateLimited(error) || attempt >= maxRetries) {
          throw error;
        }
        await sleep(retryDelayMs(error, now));
      }
    }
  }

  async function listAllPages<T>(
    fetchPage: (page: number) => Promise<GhResponse<T[]>>,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const { data } = await withRateLimitRetry(() => fetchPage(page));
      all.push(...data);
      if (data.length < PER_PAGE) {
        return all;
      }
    }
  }

  async function ensureLabelExists(owner: string, repo: string, name: string): Promise<void> {
    try {
      await withRateLimitRetry(() => client.issues.getLabel({ owner, repo, name }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await withRateLimitRetry(() => client.issues.createLabel({ owner, repo, name }));
    }
  }

  /**
   * CI status is an optional signal for the merge gate, not a load-bearing
   * one: a `GITHUB_TOKEN` without `statuses: read` (or a repo with no
   * commit statuses at all) must degrade to "unknown", never fail the
   * whole run. Only a 403 (missing scope) or 404 degrades; anything else,
   * including a rate-limited 403 that `withRateLimitRetry` gives up on,
   * still throws.
   */
  async function fetchCiStatus(
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<PullRequestData["ciStatus"]> {
    try {
      const { data: combined } = await withRateLimitRetry(() =>
        client.repos.getCombinedStatusForRef({ owner, repo, ref: headSha }),
      );
      return toCiStatus(combined.state);
    } catch (error) {
      if (!isPermissionDenied(error) && !isNotFound(error)) {
        throw error;
      }
      console.warn(
        'jevest: combined commit status not readable (403/404); reporting ciStatus as "unknown". ' +
          "Grant `permissions: { statuses: read }` to the workflow to get the real CI status.",
      );
      return "unknown";
    }
  }

  async function publishCheck(ref: PullRequestRef, publication: ReviewPublication): Promise<void> {
    const { owner, repo } = ref;
    try {
      await withRateLimitRetry(() =>
        client.checks.create({
          owner,
          repo,
          name: "jevest",
          head_sha: ref.headSha,
          status: "completed",
          conclusion: publication.check.conclusion,
          output: { title: publication.check.title, summary: publication.check.summary },
        }),
      );
    } catch (error) {
      if (!isPermissionDenied(error)) {
        throw error;
      }
      console.warn(
        "jevest: checks:write not permitted (403); falling back to the legacy commit-status API. " +
          "Grant `permissions: { checks: write }` to the workflow to get a proper GitHub check.",
      );
      await withRateLimitRetry(() =>
        client.repos.createCommitStatus({
          owner,
          repo,
          sha: ref.headSha,
          state: toCommitStatusState(publication.check.conclusion),
          context: FALLBACK_STATUS_CONTEXT,
          description: publication.check.title,
        }),
      );
    }
  }

  async function publishInlineComment(ref: PullRequestRef, comment: InlineComment): Promise<void> {
    const { owner, repo, number } = ref;
    const body = `${comment.body}\n\n${fingerprintMarker(comment.fingerprint)}`;
    const existing = await listAllPages((page) =>
      client.pulls.listReviewComments({
        owner,
        repo,
        pull_number: number,
        per_page: PER_PAGE,
        page,
      }),
    );
    const marker = fingerprintMarker(comment.fingerprint);
    const match = existing.find((c) => c.body?.includes(marker));
    if (match) {
      await withRateLimitRetry(() =>
        client.pulls.updateReviewComment({ owner, repo, comment_id: match.id, body }),
      );
      return;
    }
    await withRateLimitRetry(() =>
      client.pulls.createReviewComment({
        owner,
        repo,
        pull_number: number,
        commit_id: ref.headSha,
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body,
      }),
    );
  }

  async function publishSummary(
    ref: PullRequestRef,
    publication: ReviewPublication,
  ): Promise<void> {
    const { owner, repo, number } = ref;
    const body = `${publication.summaryMarkdown}\n\n${summaryMarker(publication.summaryFingerprint)}`;
    const existing = await listAllPages((page) =>
      client.issues.listComments({ owner, repo, issue_number: number, per_page: PER_PAGE, page }),
    );
    const prefix = summaryMarkerPrefix();
    const match = existing.find((c) => c.body?.includes(prefix));
    if (match) {
      await withRateLimitRetry(() =>
        client.issues.updateComment({ owner, repo, comment_id: match.id, body }),
      );
      return;
    }
    await withRateLimitRetry(() =>
      client.issues.createComment({ owner, repo, issue_number: number, body }),
    );
  }

  async function publishLabels(ref: PullRequestRef, publication: ReviewPublication): Promise<void> {
    const { owner, repo, number } = ref;
    if (publication.labelsToAdd.length > 0) {
      for (const name of publication.labelsToAdd) {
        await ensureLabelExists(owner, repo, name);
      }
      await withRateLimitRetry(() =>
        client.issues.addLabels({
          owner,
          repo,
          issue_number: number,
          labels: [...publication.labelsToAdd],
        }),
      );
    }
    for (const name of publication.labelsToRemove) {
      try {
        await withRateLimitRetry(() =>
          client.issues.removeLabel({ owner, repo, issue_number: number, name }),
        );
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
  }

  return {
    async fetchPullRequest(ref: PullRequestRef): Promise<PullRequestData> {
      const { owner, repo, number } = ref;
      const { data: pr } = await withRateLimitRetry(() =>
        client.pulls.get({ owner, repo, pull_number: number }),
      );
      const files = await listAllPages((page) =>
        client.pulls.listFiles({ owner, repo, pull_number: number, per_page: PER_PAGE, page }),
      );
      const ciStatus = await fetchCiStatus(owner, repo, pr.head.sha);

      return {
        ref: { owner, repo, number, headSha: pr.head.sha, baseSha: pr.base.sha },
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        labels: pr.labels.map((label) => (typeof label === "string" ? label : label.name)),
        baseBranch: pr.base.ref,
        files: files.map((file) => ({
          path: file.filename,
          status: toPullRequestFileStatus(file.status),
          additions: file.additions,
          deletions: file.deletions,
          ...(file.patch !== undefined ? { patch: file.patch } : {}),
        })),
        ciStatus,
      };
    },

    async publishReview(ref: PullRequestRef, publication: ReviewPublication): Promise<void> {
      for (const comment of publication.inlineComments) {
        await publishInlineComment(ref, comment);
      }
      await publishSummary(ref, publication);
      await publishLabels(ref, publication);
      await publishCheck(ref, publication);
    },
  };
}
