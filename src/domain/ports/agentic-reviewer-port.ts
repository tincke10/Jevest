/**
 * Port for the agentic reviewer (`reviewer.mode: agentic`): ONE agent per
 * pull request that reads the diff, then opens the changed files, their
 * callers, tests and consumers in a checkout of the PR head with
 * read-only tools, and reports only what it verified in the code. Zero SDK
 * imports; the claude-cli adapter runs `claude -p` with cwd = the checkout.
 *
 * Trust model: the agent reads repository files directly, so NFR-3
 * redaction covers what Jevest SENDS (this input: description, diff) and
 * what comes back (findings are redacted before anything else sees them),
 * while the agent's own file access is limited by the adapter's deny list
 * (env files, keys, credentials, `.git`, vendored dirs) and confined to
 * the checkout.
 */
import type { AgenticFinding } from "../agentic-finding.js";
import type { AuthorContext } from "../author-context.js";
import type { ReviewUsage } from "./reviewer-port.js";

export interface AgenticReviewInput {
  /** `owner/repo#number`, for error messages and logs only. */
  readonly prId: string;
  /** Absolute path of the checkout of the PR head: the agent's cwd. */
  readonly repoRoot: string;
  /** Redacted. */
  readonly title: string;
  /**
   * The author's context extracted from the description (sanitized), when
   * the description-context stage ran. Takes precedence over `description`.
   */
  readonly authorContext?: AuthorContext;
  /**
   * The redacted raw description, framed as untrusted data, when no
   * extracted context is available and triage did not flag injected
   * instructions. Absent otherwise.
   */
  readonly description?: string;
  /**
   * `reviewer.language`. The user message asks for `claim` and
   * `failingScenario` in it (they become the inline comment bodies); absent
   * or English adds nothing. Never goes in the static system prompt.
   */
  readonly language?: string;
  /** Every changed path, in PR order. */
  readonly changedFiles: readonly string[];
  /** The unified diff, redacted, capped by the stage. */
  readonly diff: string;
  /** What the cap cut from `diff` (files left out); absent when nothing was cut. */
  readonly diffNote?: string;
}

/** One tool call the agent made, for the run log and the read-only audit. */
export interface AgentToolCall {
  readonly tool: string;
  /** The path or pattern it targeted (`file_path`, `path`, `pattern`), when any. */
  readonly target: string | null;
  /** The CLI's permission layer refused it (e.g. a denied path). */
  readonly denied: boolean;
}

/** What every claude-cli agent run reports besides its structured output. */
export interface AgentRunInfo {
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  /** The CLI's nominal list-price cost (subscription billing). */
  readonly nominalCostUsd: number;
  readonly turns: number;
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AgenticReviewOutput extends AgentRunInfo {
  /** Already redacted (see the module doc). Empty is a valid answer. */
  readonly findings: readonly AgenticFinding[];
}

export interface AgenticReviewerPort {
  reviewPullRequest(input: AgenticReviewInput): Promise<AgenticReviewOutput>;
}
