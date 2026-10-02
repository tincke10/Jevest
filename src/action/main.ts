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
 *
 * Code context (`reviewer.fullFile` / `impactContext` / `requireEvidence`):
 * the working tree is `GITHUB_WORKSPACE` only when it is a git checkout
 * whose HEAD is the PR head sha (`actions/checkout` with
 * `ref: ${{ github.event.pull_request.head.sha }}`; the default merge ref
 * is another commit, with other line numbers, and is refused). Otherwise
 * the layers that need the tree are skipped with one line in the comment
 * and evidence is checked against the hunk text. Never a failure.
 *
 * Agentic mode (`reviewer.mode: agentic`) needs the same checkout of the
 * PR head: the agent runs `claude -p` with cwd = `GITHUB_WORKSPACE`. Without
 * it the run is `unavailable` (fail closed, never a silent per-hunk
 * fallback).
 */
import { execFile } from "node:child_process";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";
import { createClaudeCliAgenticReviewer } from "../adapters/agentic/claude-cli-agentic-reviewer.js";
import { createClaudeCliFindingVerifier } from "../adapters/agentic/claude-cli-finding-verifier.js";
import { type JevestConfig, loadJevestConfigFromString } from "../adapters/config/jevest-config.js";
import { createAnthropicDescriptionContextExtractor } from "../adapters/description-context/anthropic-description-context-extractor.js";
import { createClaudeCliDescriptionContextExtractor } from "../adapters/description-context/claude-cli-description-context-extractor.js";
import { createDeepSeekDescriptionContextExtractor } from "../adapters/description-context/deepseek-description-context-extractor.js";
import { createOpenAiDescriptionContextExtractor } from "../adapters/description-context/openai-description-context-extractor.js";
import { createAnthropicNarrator } from "../adapters/narrators/anthropic-narrator.js";
import { createClaudeCliNarrator } from "../adapters/narrators/claude-cli-narrator.js";
import { createDeepSeekNarrator } from "../adapters/narrators/deepseek-narrator.js";
import { createOpenAiNarrator } from "../adapters/narrators/openai-narrator.js";
import { createAnthropicReviewer } from "../adapters/reviewers/anthropic-reviewer.js";
import { createClaudeCliReviewer } from "../adapters/reviewers/claude-cli-reviewer.js";
import {
  DEEPSEEK_BASE_URL,
  createDeepSeekReviewer,
} from "../adapters/reviewers/deepseek-reviewer.js";
import { createOpenAiReviewer } from "../adapters/reviewers/openai-reviewer.js";
import { createGitHubIssueSpendLedger } from "../adapters/spend-ledger/github-issue-spend-ledger.js";
import { createAnthropicSummarizer } from "../adapters/summarizers/anthropic-summarizer.js";
import { createClaudeCliSummarizer } from "../adapters/summarizers/claude-cli-summarizer.js";
import { createDeepSeekSummarizer } from "../adapters/summarizers/deepseek-summarizer.js";
import { createOpenAiSummarizer } from "../adapters/summarizers/openai-summarizer.js";
import { createTypeSafeDecisionAdapter } from "../adapters/typesafe-decision-adapter.js";
import {
  type GitHubVcsAdapter,
  createGitHubVcsAdapter,
} from "../adapters/vcs/github-vcs-adapter.js";
import { createRipgrepWorkingTree } from "../adapters/working-tree/ripgrep-working-tree.js";
import { type ProductContext, loadProductContext } from "../application/context/product-context.js";
import { type PipelineResult, runPipeline } from "../application/pipeline/run-pipeline.js";
import {
  CalibrationError,
  type CalibrationMap,
  NO_CALIBRATION,
  parseCalibrationFile,
} from "../domain/calibration.js";
import type { AgenticReviewerPort } from "../domain/ports/agentic-reviewer-port.js";
import type { ChangeSummarizerPort } from "../domain/ports/change-summarizer-port.js";
import type { DescriptionContextPort } from "../domain/ports/description-context-port.js";
import type { FindingVerifierPort } from "../domain/ports/finding-verifier-port.js";
import type { ReviewNarratorPort } from "../domain/ports/review-narrator-port.js";
import type { ReviewerPort } from "../domain/ports/reviewer-port.js";
import type { VcsPort } from "../domain/ports/vcs-port.js";
import type { WorkingTreePort } from "../domain/ports/working-tree-port.js";
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
 * The first error a 0.1 workflow (an API key, no `.jevest.yml` provider)
 * hits on 1.0, where claude-cli is the built-in provider: it names both ways
 * out. The other claude-cli ports repeat a shorter variant after this one.
 */
const MISSING_CLAUDE_TOKEN_MESSAGE =
  'input "claude-code-oauth-token" is required because reviewer.provider is claude-cli (the default since 1.0 when .jevest.yml does not set it). ' +
  "Add `claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` to the Jevest step (a repository secret from `claude setup-token`), " +
  "or set reviewer.provider in .jevest.yml (e.g. `reviewer.provider: anthropic` with the anthropic-api-key input, the 0.1 default). See docs/MIGRATING.md.";

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
      throw new ActionInputError(MISSING_CLAUDE_TOKEN_MESSAGE);
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

/**
 * Agentic mode's ports (`reviewer.mode: agentic`): the one-agent-per-PR
 * reviewer and, when `reviewer.verifier` is "claude-cli", the per-finding
 * verifier. Both run `claude -p` on the same subscription token as the
 * claude-cli reviewer (config validation already requires that provider).
 * `{}` in the per-hunk mode.
 */
export function createAgenticPorts(
  config: JevestConfig,
  inputs: ActionInputs,
): { agenticReviewer?: AgenticReviewerPort; findingVerifier?: FindingVerifierPort } {
  const { reviewer } = config;
  if (reviewer.mode !== "agentic") return {};
  if (inputs.claudeCodeOauthToken === undefined) {
    throw new ActionInputError(
      'input "claude-code-oauth-token" is required because .jevest.yml selects reviewer.mode: agentic',
    );
  }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken;
  return {
    agenticReviewer: createClaudeCliAgenticReviewer({
      ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
      maxTurns: reviewer.agentic.maxTurns,
      effort: reviewer.agentic.effort,
      timeoutMs: reviewer.agentic.timeoutMs,
    }),
    ...(reviewer.verifier === "claude-cli"
      ? {
          findingVerifier: createClaudeCliFindingVerifier({
            model: reviewer.verifierModel,
            maxTurns: reviewer.agentic.verifierMaxTurns,
            effort: reviewer.verifierEffort,
            timeoutMs: reviewer.agentic.verifierTimeoutMs,
          }),
        }
      : {}),
  };
}

/**
 * The change summarizer for triage v2 (H7), built from the SAME provider,
 * model and credential as the reviewer — one LLM per repo, one key to
 * manage. `undefined` when `triage.changeSummary` is "never", or "auto"
 * in Jev-only mode (provider "none"); config validation already rejects
 * "always" without a provider. The credential checks are the reviewer's,
 * repeated here so a summary-only misconfiguration names the right input.
 */
export function createSummarizer(
  config: JevestConfig,
  inputs: ActionInputs,
): ChangeSummarizerPort | undefined {
  const { provider, model } = config.reviewer;
  if (config.triage.changeSummary === "never" || provider === "none") {
    return undefined;
  }
  if (model === undefined) {
    throw new ActionInputError(
      `.jevest.yml: reviewer.model is required when reviewer.provider is "${provider}"`,
    );
  }
  if (provider === "anthropic") {
    if (inputs.anthropicApiKey === undefined) {
      throw new ActionInputError(
        'input "anthropic-api-key" is required because .jevest.yml selects the anthropic reviewer (the change summary uses it too)',
      );
    }
    return createAnthropicSummarizer({
      client: new Anthropic({ apiKey: inputs.anthropicApiKey }),
      model,
    });
  }
  if (provider === "deepseek") {
    if (inputs.deepseekApiKey === undefined) {
      throw new ActionInputError(
        'input "deepseek-api-key" is required because .jevest.yml selects the deepseek reviewer (the change summary uses it too)',
      );
    }
    return createDeepSeekSummarizer({
      client: new OpenAI({ apiKey: inputs.deepseekApiKey, baseURL: DEEPSEEK_BASE_URL }),
      model,
    });
  }
  if (provider === "claude-cli") {
    if (inputs.claudeCodeOauthToken === undefined) {
      throw new ActionInputError(
        'input "claude-code-oauth-token" is required because .jevest.yml selects the claude-cli reviewer (the change summary uses it too)',
      );
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken;
    return createClaudeCliSummarizer({ model });
  }
  if (inputs.openaiApiKey === undefined) {
    throw new ActionInputError(
      'input "openai-api-key" is required because .jevest.yml selects the openai reviewer (the change summary uses it too)',
    );
  }
  return createOpenAiSummarizer({ client: new OpenAI({ apiKey: inputs.openaiApiKey }), model });
}

/**
 * The review narrator (colleague review), built exactly like the change
 * summarizer: the reviewer's provider, model and credential. `undefined`
 * when `reviewer.narrative` is false, which config resolution already makes
 * the case for provider "none". The credential checks repeat the
 * reviewer's so a narrator-only misconfiguration names the right input.
 */
export function createNarrator(
  config: JevestConfig,
  inputs: ActionInputs,
): ReviewNarratorPort | undefined {
  const { provider, model, narrative } = config.reviewer;
  if (!narrative || provider === "none") {
    return undefined;
  }
  if (model === undefined) {
    throw new ActionInputError(
      `.jevest.yml: reviewer.model is required when reviewer.provider is "${provider}"`,
    );
  }
  if (provider === "anthropic") {
    if (inputs.anthropicApiKey === undefined) {
      throw new ActionInputError(
        'input "anthropic-api-key" is required because .jevest.yml selects the anthropic reviewer (the review narrative uses it too)',
      );
    }
    return createAnthropicNarrator({
      client: new Anthropic({ apiKey: inputs.anthropicApiKey }),
      model,
    });
  }
  if (provider === "deepseek") {
    if (inputs.deepseekApiKey === undefined) {
      throw new ActionInputError(
        'input "deepseek-api-key" is required because .jevest.yml selects the deepseek reviewer (the review narrative uses it too)',
      );
    }
    return createDeepSeekNarrator({
      client: new OpenAI({ apiKey: inputs.deepseekApiKey, baseURL: DEEPSEEK_BASE_URL }),
      model,
    });
  }
  if (provider === "claude-cli") {
    if (inputs.claudeCodeOauthToken === undefined) {
      throw new ActionInputError(
        'input "claude-code-oauth-token" is required because .jevest.yml selects the claude-cli reviewer (the review narrative uses it too)',
      );
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken;
    return createClaudeCliNarrator({ model });
  }
  if (inputs.openaiApiKey === undefined) {
    throw new ActionInputError(
      'input "openai-api-key" is required because .jevest.yml selects the openai reviewer (the review narrative uses it too)',
    );
  }
  return createOpenAiNarrator({ client: new OpenAI({ apiKey: inputs.openaiApiKey }), model });
}

/**
 * The description-context extractor (author context for the reviewer),
 * built exactly like the narrator: the reviewer's provider, model and
 * credential. `undefined` when `reviewer.descriptionContext` is false,
 * which config resolution already makes the case for provider "none".
 */
export function createDescriptionContextExtractor(
  config: JevestConfig,
  inputs: ActionInputs,
): DescriptionContextPort | undefined {
  const { provider, model, descriptionContext } = config.reviewer;
  if (!descriptionContext || provider === "none") {
    return undefined;
  }
  if (model === undefined) {
    throw new ActionInputError(
      `.jevest.yml: reviewer.model is required when reviewer.provider is "${provider}"`,
    );
  }
  if (provider === "anthropic") {
    if (inputs.anthropicApiKey === undefined) {
      throw new ActionInputError(
        'input "anthropic-api-key" is required because .jevest.yml selects the anthropic reviewer (the description context uses it too)',
      );
    }
    return createAnthropicDescriptionContextExtractor({
      client: new Anthropic({ apiKey: inputs.anthropicApiKey }),
      model,
    });
  }
  if (provider === "deepseek") {
    if (inputs.deepseekApiKey === undefined) {
      throw new ActionInputError(
        'input "deepseek-api-key" is required because .jevest.yml selects the deepseek reviewer (the description context uses it too)',
      );
    }
    return createDeepSeekDescriptionContextExtractor({
      client: new OpenAI({ apiKey: inputs.deepseekApiKey, baseURL: DEEPSEEK_BASE_URL }),
      model,
    });
  }
  if (provider === "claude-cli") {
    if (inputs.claudeCodeOauthToken === undefined) {
      throw new ActionInputError(
        'input "claude-code-oauth-token" is required because .jevest.yml selects the claude-cli reviewer (the description context uses it too)',
      );
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inputs.claudeCodeOauthToken;
    return createClaudeCliDescriptionContextExtractor({ model });
  }
  if (inputs.openaiApiKey === undefined) {
    throw new ActionInputError(
      'input "openai-api-key" is required because .jevest.yml selects the openai reviewer (the description context uses it too)',
    );
  }
  return createOpenAiDescriptionContextExtractor({
    client: new OpenAI({ apiKey: inputs.openaiApiKey }),
    model,
  });
}

/**
 * Resolves `.jevest/context.yml` (see src/application/context/product-context.ts)
 * from the PR's BASE sha via the contents API — deliberately NOT from the
 * local checkout, unlike `resolveConfig`: a checkout is the PR head, and a
 * PR must not be able to rewrite the rules that judge it. A missing file
 * is the empty context; an invalid one throws, naming the source, and the
 * run fails closed exactly like a bad `.jevest.yml`. Logs one line.
 */
export async function resolveProductContext(
  vcs: GitHubVcsAdapter,
  ref: PullRequestRef,
  contextPath: string,
): Promise<ProductContext> {
  const label = `${ref.owner}/${ref.repo}@${ref.baseSha}:${contextPath}`;
  const context = await loadProductContext({
    fetchFile: (path, sha) =>
      vcs.fetchRepoFileContent({ owner: ref.owner, repo: ref.repo, path, ref: sha }),
    path: contextPath,
    baseSha: ref.baseSha,
    label,
  });
  if (context.product === null && context.areas.length === 0) {
    console.log(`jevest: no product context at ${label}; triage runs without product areas`);
  } else {
    console.log(`jevest: product context fetched from ${label} (${context.areas.length} area(s))`);
  }
  return context;
}

/**
 * Resolves the stage-4 calibration map for `is_real_defect` (SPEC §4.6.3).
 * Same fetch path and same rule as {@link resolveProductContext}: the PR's
 * BASE sha via the contents API, never the head and never the local checkout,
 * because the map decides which of this PR's findings get published and the
 * PR must not be able to rewrite it.
 *
 * Where it deliberately differs: a MISSING file is an ERROR here. An absent
 * product context means "this repo has no areas yet", which is a real state;
 * an absent calibration file when the config explicitly says
 * `calibration: file` means the repo asked for a map and there is none —
 * falling back to the identity would run the whole PR under a policy nobody
 * chose, silently. `calibration: "none"` (the default) short-circuits before
 * any API call. Logs one line either way.
 */
export async function resolveCalibration(
  vcs: GitHubVcsAdapter,
  ref: PullRequestRef,
  findingFilter: JevestConfig["findingFilter"],
): Promise<CalibrationMap> {
  if (findingFilter.calibration === "none") {
    return NO_CALIBRATION;
  }
  const path = findingFilter.calibrationPath;
  const label = `${ref.owner}/${ref.repo}@${ref.baseSha}:${path}`;
  const raw = await vcs.fetchRepoFileContent({
    owner: ref.owner,
    repo: ref.repo,
    path,
    ref: ref.baseSha,
  });
  if (raw === null) {
    throw new CalibrationError(
      `${label}: not found, but .jevest.yml sets findingFilter.calibration: file. Commit the map there, or set calibration: none.`,
    );
  }
  const map = parseCalibrationFile(raw, label);
  console.log(`jevest: calibration map fetched from ${label} (method ${map.method})`);
  return map;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Resolves `.jevest.yml` without requiring a checkout (see docs/ACTION.md
 * "Checkout"): reads `configPath` off disk first — covers a
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
  // Relative to the CONSUMER's workspace, not the cwd: the action step runs
  // in github.action_path, where Jevest's own .jevest.yml would win.
  const localPath = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), configPath);
  try {
    const raw = await readFile(localPath, "utf8");
    console.log(`jevest: config loaded from the local checkout (${configPath})`);
    return await loadJevestConfigFromString(raw, configPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  // BASE sha, never head (same rule as the product context): the config
  // holds the thresholds, provider and budget that judge the PR, so the PR
  // itself must not be able to rewrite them. It also means a branch opened
  // before `.jevest.yml` landed on the base branch still gets the repo's
  // config instead of the built-in defaults.
  const label = `${ref.owner}/${ref.repo}@${ref.baseSha}:${configPath}`;
  const remote = await vcs.fetchRepoFileContent({
    owner: ref.owner,
    repo: ref.repo,
    path: configPath,
    ref: ref.baseSha,
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
 * the ledger was unreachable — see `spendCapAnnotations`). `findings-low-
 * confidence` is stage 4's `lowConfidence` bucket count (`mode: "annotate"`,
 * H1 pending — see stages/finding-filter.ts); always 0 in `mode: "discard"`.
 * The last three are the run's H4 / H2 numbers (run-metrics.ts): always
 * present, zeros when a stage did not run; `llm-tokens-saved-pct` is an
 * estimate, see docs/BENCHMARK.md "H2 / H4 — measured per run".
 */
/** Probes behind {@link resolveActionWorkingTree}, injectable for tests. */
export interface WorkspaceProbe {
  hasGitDir(dir: string): Promise<boolean>;
  headSha(dir: string): Promise<string>;
}

const DEFAULT_WORKSPACE_PROBE: WorkspaceProbe = {
  async hasGitDir(dir) {
    try {
      await stat(join(dir, ".git"));
      return true;
    } catch {
      return false;
    }
  },
  headSha(dir) {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: dir, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
      );
    });
  },
};

/**
 * The working tree for the code-context layers and agentic mode (see the
 * module doc): `{}` when nothing needs it, a tree over `workspace` (and
 * its path, the agent's cwd) when it is a checkout of the PR head, else
 * the reason for the comment's one line.
 */
export async function resolveActionWorkingTree(
  config: JevestConfig,
  ref: PullRequestRef,
  workspace: string | undefined,
  probe: WorkspaceProbe = DEFAULT_WORKSPACE_PROBE,
): Promise<{ workingTree?: WorkingTreePort; root?: string; unavailableReason?: string }> {
  const { reviewer } = config;
  const wanted =
    reviewer.provider !== "none" &&
    (reviewer.mode === "agentic" ||
      reviewer.fullFile ||
      reviewer.impactContext ||
      reviewer.requireEvidence);
  if (!wanted) return {};
  if (workspace === undefined || workspace === "" || !(await probe.hasGitDir(workspace))) {
    return { unavailableReason: "no checkout" };
  }
  let head: string;
  try {
    head = (await probe.headSha(workspace)).trim();
  } catch {
    return { unavailableReason: "no checkout" };
  }
  if (head !== ref.headSha) {
    return {
      unavailableReason: `no checkout of the PR head (the workspace is at ${head.slice(0, 7)}; check out ref: the PR head sha)`,
    };
  }
  return { workingTree: createRipgrepWorkingTree({ root: workspace }), root: workspace };
}

/**
 * What to log about a missing working tree. In agentic mode it is a
 * `::warning::` annotation (shown on the workflow run, not only in the log)
 * with the exact step to add, because the run cannot review anything
 * without it; for the optional code-context layers a plain log line.
 * Annotations are one line, so the step is written inline.
 */
export function workingTreeAnnotations(
  config: JevestConfig,
  unavailableReason: string | undefined,
): string[] {
  if (unavailableReason === undefined) return [];
  if (config.reviewer.mode === "agentic" && config.reviewer.provider !== "none") {
    return [
      `::warning title=Jevest agentic review needs a checkout::${unavailableReason}. Agentic mode (the default) reads the repository from a checkout of the PR head; this run is "unavailable". Add before the Jevest step: \`- uses: actions/checkout@v4\` with \`ref: \${{ github.event.pull_request.head.sha }}\` and \`fetch-depth: 1\`. Or set reviewer.mode: hunks in .jevest.yml (legacy per-hunk reviewer, no checkout needed).`,
    ];
  }
  return [`jevest: code context unavailable: ${unavailableReason}`];
}

export function buildOutputLines(result: PipelineResult): string {
  const { metrics } = result;
  return (
    `check-conclusion=${result.check.conclusion}\n` +
    `findings-published=${result.findingsPublished}\n` +
    `findings-low-confidence=${result.findingsLowConfidence}\n` +
    `cost-usd=${result.costUsd}\n` +
    `spend-usd=${result.spendCap?.spentUsd ?? ""}\n` +
    `jev-latency-p95-ms=${metrics.jev.latency.p95Ms}\n` +
    `jev-requests=${metrics.jev.requests.total}\n` +
    `llm-tokens-saved-pct=${metrics.llm.tokensSavedPct}\n`
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
    const summarizer = createSummarizer(config, inputs);
    const narrator = createNarrator(config, inputs);
    const descriptionContext = createDescriptionContextExtractor(config, inputs);
    const agenticPorts = createAgenticPorts(config, inputs);
    const productContext = await resolveProductContext(vcs, ref, config.triage.productContextPath);
    const calibration = await resolveCalibration(vcs, ref, config.findingFilter);
    const tree = await resolveActionWorkingTree(config, ref, env.GITHUB_WORKSPACE);
    for (const line of workingTreeAnnotations(config, tree.unavailableReason)) {
      console.log(line);
    }
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
      ports: {
        vcs,
        decision,
        spendLedger,
        ...(reviewer ? { reviewer } : {}),
        ...(summarizer ? { summarizer } : {}),
        ...(narrator ? { narrator } : {}),
        ...(descriptionContext ? { descriptionContext } : {}),
        ...(tree.workingTree ? { workingTree: tree.workingTree } : {}),
        ...agenticPorts,
      },
      ...(tree.unavailableReason ? { workingTreeUnavailableReason: tree.unavailableReason } : {}),
      ...(tree.root ? { headCheckoutRoot: tree.root } : {}),
      config,
      productContext,
      calibration,
    });

    console.log(
      `jevest: PR #${ref.number} — check=${result.check.conclusion} findings=${result.findingsPublished} cost=$${result.costUsd.toFixed(4)}`,
    );
    console.log(
      `jevest: efficiency — jev requests=${result.metrics.jev.requests.total} p95=${result.metrics.jev.latency.p95Ms}ms total=${result.metrics.jev.latency.sumMs}ms · llm hunks reviewed=${result.metrics.llm.hunks.reviewed}/${result.metrics.llm.hunks.total} failed=${result.metrics.llm.hunks.failed} tokens=${result.metrics.llm.tokens.spent} saved≈${result.metrics.llm.tokensSavedPct}% (estimate) · wall=${result.metrics.wallTime.totalMs}ms`,
    );
    const agentic = result.metrics.agentic;
    if (agentic) {
      console.log(
        `jevest: agentic — status=${agentic.status} turns=${agentic.turns} tokens=${agentic.tokens.total} cost=$${agentic.costUsd.toFixed(4)} tools=${JSON.stringify(agentic.toolCalls)} denied=${agentic.deniedToolCalls} verifier calls=${agentic.verifier.calls} jev judge=${agentic.jevJudgeCalls} drops=${JSON.stringify(agentic.dropsByReason)}`,
      );
    }
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
