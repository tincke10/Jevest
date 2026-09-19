/**
 * Shared VCS-agnostic PR shape (SPEC §7, Fase 1b/2): the exact contract
 * both the local-diff adapter (mine) and the GitHub adapter (github agent)
 * implement, so the pipeline never knows which one it's talking to. Copied
 * verbatim from the cross-agent contract — do not diverge without saying
 * so loudly, the github agent must match.
 */

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
}

export interface PullRequestFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  /** Unified diff for this file, as GitHub returns it. */
  patch?: string;
}

export interface PullRequestData {
  ref: PullRequestRef;
  title: string;
  body: string;
  author: string;
  labels: string[];
  baseBranch: string;
  files: PullRequestFile[];
  ciStatus: "success" | "failure" | "pending" | "unknown";
}
