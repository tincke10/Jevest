/**
 * GitHub Action entrypoint (SPEC §5 Fase 2, FR-6.4, FR-7, NFR-2, NFR-9).
 * Wires the real SDK clients behind the ports and runs the pipeline. This
 * file (and action.yml, which invokes it with `tsx`) is the only place in
 * the repo allowed to import GitHub-specific SDKs alongside
 * ../adapters/vcs/github-vcs-adapter.ts (hexagonal boundary).
 *
 * Fail-closed (NFR-2): on any unexpected exception this always tries to
 * publish a failure check first, so a broken run never leaves a stale green
 * check on the PR, and only sets a non-zero exit code when `fail-on:
 * "failure"` was configured — the check itself always carries the real
 * signal, the job's exit code is opt-in (FR-6.4: this never merges either
 * way, it only ever emits signal).
 *
 * `parseActionInputs` and the `pull_request` / `pull_request_target` event
 * parsing below have no dependency on the pipeline module, so they're safe
 * to unit test without touching a network or a missing module.
 */
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";
import { type JevestConfig, loadJevestConfigFromString } from "../adapters/config/jevest-config.js";
import { createAnthropicReviewer } from "../adapters/reviewers/anthropic-reviewer.js";
import { createClaudeCliReviewer } from "../adapters/reviewers/claude-cli-reviewer.js";
import {
  DEEPSEEK_BASE_URL,
  createDeepSeekReviewer,
} from "../adapters/reviewers/deepseek-reviewer.js";
import { createOpenAiReviewer } from "../adapters/reviewers/openai-reviewer.js";
import { createGitHubIssueSpendLedger } from "../adapters/spend-ledger/github-issue-spend-ledger.js";
import { createTypeSafeDecisionAdapter } from "../adapters/typesafe-decision-adapter.js";
import {
  type GitHubVcsAdapter,
  createGitHubVcsAdapter,
} from "../adapters/vcs/github-vcs-adapter.js";
import { type PipelineResult, runPipeline } from "../application/pipeline/run-pipeline.js";
import type { ReviewerPort } from "../domain/ports/reviewer-port.js";
import type { VcsPort } from "../domain/ports/vcs-port.js";
import type { PullRequestRef } from "../domain/pull-request.js";

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export type FailOn = "never" | "failure";

export interface ActionInputs {
  readonly configPath: string;
  readonly typesafeApiKey: string;
  readonly anthropicApiKey?: string;
  readonly openaiApiKey?: string;
  readonly deepseekApiKey?: string;
  /** Long-lived OAuth token from `claude setup-token` (Claude Pro/Max), for the claude-cli reviewer. */
  readonly claudeCodeOauthToken?: string;
  readonly githubToken: string;
  readonly failOn: FailOn;
}

const DEFAULT_CONFIG_PATH = ".jevest.yml";
const DEFAULT_FAIL_ON: FailOn = "never";

/**
 * GitHub Actions turns an input named e.g. `github-token` into the
 * environment variable `INPUT_GITHUB-TOKEN` — uppercased, with SPACES (not
 * dashes) replaced by underscores (see actions/toolkit `core.getInput`).
 * Hyphens in the input name survive untouched. Easy to get wrong once and
 * silently read `undefined` forever.
 */
function inputEnvVar(name: string): string {
  return `INPUT_${name.replace(/[ -]/g, "_").toUpperCase()}`;
}

function readInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[inputEnvVar(name)];
  return value === undefined || value === "" ? undefined : value;
}

function requireInput(env: NodeJS.ProcessEnv, name: string): string {
  const value = readInput(env, name);
  if (value === undefined) {
    throw new ActionInputError(`missing required input "${name}" (env var ${inputEnvVar(name)})`);
  }
  return value;
}

function requireEnvVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ActionInputError(`missing required environment variable "${name}"`);
  }
  return value;
}

export function parseActionInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const githubToken = requireInput(env, "github-token");
  const typesafeApiKey = requireInput(env, "typesafe-api-key");
  const anthropicApiKey = readInput(env, "anthropic-api-key");
  const openaiApiKey = readInput(env, "openai-api-key");
  const deepseekApiKey = readInput(env, "deepseek-api-key");
  const claudeCodeOauthToken = readInput(env, "claude-code-oauth-token");
  const configPath = readInput(env, "config-path") ?? DEFAULT_CONFIG_PATH;
  const failOnRaw = readInput(env, "fail-on") ?? DEFAULT_FAIL_ON;
  if (failOnRaw !== "never" && failOnRaw !== "failure") {
    throw new ActionInputError(`input "fail-on" must be "never" or "failure", got "${failOnRaw}"`);
  }

  return {
    configPath,
    typesafeApiKey,
    githubToken,
    failOn: failOnRaw,
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(deepseekApiKey !== undefined ? { deepseekApiKey } : {}),
    ...(claudeCodeOauthToken !== undefined ? { claudeCodeOauthToken } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a {@link PullRequestRef} from a `pull_request` or
 * `pull_request_target` webhook payload (SPEC §5 Fase 2). Both event types
 * share this exact shape for the fields used here.
 */
export function pullRequestRefFromEventPayload(event: unknown): PullRequestRef {
  if (!isPlainObject(event)) {
    throw new ActionInputError("GITHUB_EVENT_PATH payload must be a JSON object");
  }
  const pr = event.pull_request;
  if (!isPlainObject(pr)) {
    throw new ActionInputError(
      'event payload has no "pull_request" object — expected a "pull_request" or "pull_request_target" event',
    );
  }
  const repository = event.repository;
  if (!isPlainObject(repository) || !isPlainObject(repository.owner)) {
    throw new ActionInputError('event payload has no "repository.owner.login" / "repository.name"');
  }
  const head = pr.head;
  const base = pr.base;
  if (!isPlainObject(head) || !isPlainObject(base)) {
    throw new ActionInputError('event payload\'s "pull_request" is missing "head" or "base"');
  }
  const number = pr.number;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = head.sha;
  const baseSha = base.sha;
  if (
    typeof number !== "number" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof headSha !== "string" ||
    typeof baseSha !== "string"
  ) {
    throw new ActionInputError(
      "event payload has the wrong types for pull_request/repository fields",
    );
  }

  return { owner, repo, number, headSha, baseSha };
}

export async function loadPullRequestRefFromEvent(eventPath: string): Promise<PullRequestRef> {
  const raw = await readFile(eventPath, "utf8");
  const event: unknown = JSON.parse(raw);
  return pullRequestRefFromEventPayload(event);
}

/**
 * `undefined` means `reviewer.provider: "none"` — Jev-only mode (SPEC
 * rollout decision): run-pipeline.ts never calls a reviewer in that case,
 * so no LLM key is required and none is validated here.
 */
export function createReviewer(
  config: JevestConfig,
  inputs: ActionInputs,
): ReviewerPort | undefined {
  const { provider, model } = config.reviewer;
  if (provider === "none") {
    return undefined;
  }
  if (model === undefined) {
    // jevest-config.ts's schema already requires this for "anthropic"/"openai"; defensive only.
    throw new ActionInputError(
      `.jevest.yml: reviewer.model is required when reviewer.provider is "${provider}"`,
    );
  }
  if (provider === "anthropic") {
    if (inputs.anthropicApiKey === undefined) {
      throw new ActionInputError(
        'input "anthropic-api-key" is required because .jevest.yml selects the anthropic reviewer',
      );
    }
    return createAnthropicReviewer({
      client: new Anthropic({ apiKey: inputs.anthropicApiKey }),
      model,
    });
  }
  if (provider === "deepseek") {
    if (inputs.deepseekApiKey === undefined) {
      throw new ActionInputError(
        'input "deepseek-api-key" is required because .jevest.yml selects the deepseek reviewer',
      );
    }
    // DeepSeek speaks the OpenAI wire protocol: same SDK, different base URL.
    return createDeepSeekReviewer({
      client: new OpenAI({ apiKey: inputs.deepseekApiKey, baseURL: DEEPSEEK_BASE_URL }),
      model,
    });
  }
  if (provider === "claude-cli") {
    // Bills a Claude Pro/Max subscription through `claude -p`, authenticated
    // by the long-lived OAuth token from `claude setup-token` — the same
    // mechanism Anthropic's own claude-code-action uses for subscribers.
    // The token belongs to ONE person's subscription: the consumer repo's
    // owner accepts that every PR review draws on that person's quota.
    if (inputs.claudeCodeOauthToken === undefined) {
      throw new ActionInputError(
        'input "claude-code-oauth-token" is required because .jevest.yml selects the claude-cli reviewer',
      );
    }
    // The claude-cli seam spawns `claude` with the current process env (minus
    // ANTHROPIC_API_KEY, which would shadow the subscription); the CLI reads
    // this variable to authenticate without an interactive login.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken;
    return createClaudeCliReviewer({ model });
  }
  if (inputs.openaiApiKey === undefined) {
    throw new ActionInputError(
      'input "openai-api-key" is required because .jevest.yml selects the openai reviewer',
    );
  }
  return createOpenAiReviewer({ client: new OpenAI({ apiKey: inputs.openaiApiKey }), model });
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Resolves `.jevest.yml` without requiring a checkout (see docs/ACTION.md
 * "Why no checkout"): reads `configPath` off disk first — covers a
 * workflow that DOES check out anyway, or a local `pnpm action` run — and
 * only if it's not there, fetches it from the PR head sha via the GitHub
 * contents API instead. A file absent from BOTH places is not an error:
 * exactly like an empty file, it means "use the built-in defaults from
 * config/jevest.example.yml" (`loadJevestConfigFromString("", ...)`).
 * Always logs exactly one line naming which of the three sources was used.
 */
export async function resolveConfig(
  vcs: GitHubVcsAdapter,
  ref: PullRequestRef,
  configPath: string,
): Promise<JevestConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    console.log(`jevest: config loaded from the local checkout (${configPath})`);
    return await loadJevestConfigFromString(raw, configPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const label = `${ref.owner}/${ref.repo}@${ref.headSha}:${configPath}`;
  const remote = await vcs.fetchRepoFileContent({
    owner: ref.owner,
    repo: ref.repo,
    path: configPath,
    ref: ref.headSha,
  });
  if (remote === null) {
    console.log(`jevest: config not found locally or at ${label}; using the built-in defaults`);
    return await loadJevestConfigFromString("", configPath);
  }
  console.log(`jevest: config fetched from ${label} via the GitHub API`);
  return await loadJevestConfigFromString(remote, label);
}

/**
 * The `GITHUB_OUTPUT` lines, one per output declared in action.yml.
 * `spend-usd` is the cumulative total AFTER this run per the spend ledger;
 * empty when unknown (no ledger, run ended before the review stage, or
 * the ledger was unreachable — see `spendCapAnnotations`).
 */
export function buildOutputLines(result: PipelineResult): string {
  return (
    `check-conclusion=${result.check.conclusion}\n` +
    `findings-published=${result.findingsPublished}\n` +
    `cost-usd=${result.costUsd}\n` +
    `spend-usd=${result.spendCap?.spentUsd ?? ""}\n`
  );
}

/**
 * Workflow annotations for the cumulative spend cap (NFR-10). Always
 * `::warning::`, never `::error::`, even when the cap is reached: a reached
 * cap degrades the run to Jev-only, it is not a failed review, and
 * fail-closed semantics (`fail-on`) are unchanged by it.
 */
export function spendCapAnnotations(result: PipelineResult): string[] {
  const lines: string[] = [];
  const cap = result.spendCap;
  if (cap && cap.status !== "ok") {
    const detail = result.reviewSkippedForSpendCap ? " (LLM review skipped on this run)" : "";
    lines.push(
      `::warning::Jevest spend cap: USD ${cap.spentUsd.toFixed(2)} of ${cap.capUsd.toFixed(2)} (period ${cap.periodKey}) — ${cap.status}${detail}`,
    );
  }
  if (result.spendLedgerError) {
    lines.push(
      `::warning::Jevest spend ledger unavailable: ${result.spendLedgerError} — cumulative cap not enforced on this run`,
    );
  }
  return lines;
}

async function writeOutputs(env: NodeJS.ProcessEnv, result: PipelineResult): Promise<void> {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.warn(
      "jevest: GITHUB_OUTPUT is not set; skipping action outputs (expected only outside a real run)",
    );
    return;
  }
  await appendFile(outputPath, buildOutputLines(result), "utf8");
}

async function publishFailureCheck(
  vcs: VcsPort,
  ref: PullRequestRef,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await vcs.publishReview(ref, {
    summaryMarkdown: `## jevest\n\nThe review run failed unexpectedly:\n\n\`\`\`\n${message}\n\`\`\``,
    summaryFingerprint: "internal-error",
    inlineComments: [],
    labelsToAdd: [],
    labelsToRemove: [],
    check: { conclusion: "failure", title: "jevest: run failed", summary: message },
  });
}

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Deliberately outside the try/catch below and NOT governed by `fail-on`:
  // a missing/invalid input means the *workflow* is misconfigured (e.g. a
  // required secret was never set), not that the review run degraded. There
  // is also no `github-token` yet at this point, so there is no way to
  // publish a check even if we wanted to fail closed here. This always
  // throws and always exits non-zero, on purpose — see docs/ACTION.md
  // "Fail-closed behavior".
  const inputs = parseActionInputs(env);

  let vcs: GitHubVcsAdapter | undefined;
  let ref: PullRequestRef | undefined;

  try {
    const eventPath = requireEnvVar(env, "GITHUB_EVENT_PATH");
    ref = await loadPullRequestRefFromEvent(eventPath);
    const octokit = new Octokit({ auth: inputs.githubToken });
    vcs = createGitHubVcsAdapter({ client: octokit });
    const config = await resolveConfig(vcs, ref, inputs.configPath);

    const decision = createTypeSafeDecisionAdapter({
      client: new TypeSafeClient({ apiKey: inputs.typesafeApiKey, retry: { maxRetries: 0 } }),
    });
    const reviewer = createReviewer(config, inputs);
    // Same token, same `issues: write` permission the summary comment and
    // labels already need — the ledger is one issue in the consumer repo.
    const spendLedger = createGitHubIssueSpendLedger({
      client: octokit,
      owner: ref.owner,
      repo: ref.repo,
      cap: config.spendCap,
    });

    const result: PipelineResult = await runPipeline({
      ref,
      ports: { vcs, decision, spendLedger, ...(reviewer ? { reviewer } : {}) },
      config,
    });

    console.log(
      `jevest: PR #${ref.number} — check=${result.check.conclusion} findings=${result.findingsPublished} cost=$${result.costUsd.toFixed(4)}`,
    );
    for (const line of spendCapAnnotations(result)) {
      console.log(line);
    }
    await writeOutputs(env, result);

    if (inputs.failOn === "failure" && result.check.conclusion === "failure") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("jevest: unexpected failure", error);
    if (vcs && ref) {
      try {
        await publishFailureCheck(vcs, ref, error);
      } catch (publishError) {
        console.error("jevest: also failed to publish the fail-closed failure check", publishError);
      }
    }
    if (inputs.failOn === "failure") {
      process.exitCode = 1;
    }
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await run();
}
