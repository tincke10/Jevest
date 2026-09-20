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
import { type JevestConfig, loadJevestConfig } from "../adapters/config/jevest-config.js";
import { createAnthropicReviewer } from "../adapters/reviewers/anthropic-reviewer.js";
import { createOpenAiReviewer } from "../adapters/reviewers/openai-reviewer.js";
import { createTypeSafeDecisionAdapter } from "../adapters/typesafe-decision-adapter.js";
import { createGitHubVcsAdapter } from "../adapters/vcs/github-vcs-adapter.js";
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
  if (inputs.openaiApiKey === undefined) {
    throw new ActionInputError(
      'input "openai-api-key" is required because .jevest.yml selects the openai reviewer',
    );
  }
  return createOpenAiReviewer({ client: new OpenAI({ apiKey: inputs.openaiApiKey }), model });
  // Deliberately no "claude-cli" branch: that reviewer spends a Claude
  // subscription's quota interactively and has no place in unattended CI.
}

async function writeOutputs(env: NodeJS.ProcessEnv, result: PipelineResult): Promise<void> {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.warn(
      "jevest: GITHUB_OUTPUT is not set; skipping action outputs (expected only outside a real run)",
    );
    return;
  }
  const lines =
    `check-conclusion=${result.check.conclusion}\n` +
    `findings-published=${result.findingsPublished}\n` +
    `cost-usd=${result.costUsd}\n`;
  await appendFile(outputPath, lines, "utf8");
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

  let vcs: VcsPort | undefined;
  let ref: PullRequestRef | undefined;

  try {
    const eventPath = requireEnvVar(env, "GITHUB_EVENT_PATH");
    ref = await loadPullRequestRefFromEvent(eventPath);
    vcs = createGitHubVcsAdapter({ client: new Octokit({ auth: inputs.githubToken }) });
    const config = await loadJevestConfig(inputs.configPath);

    const decision = createTypeSafeDecisionAdapter({
      client: new TypeSafeClient({ apiKey: inputs.typesafeApiKey, retry: { maxRetries: 0 } }),
    });
    const reviewer = createReviewer(config, inputs);

    const result: PipelineResult = await runPipeline({
      ref,
      ports: { vcs, decision, ...(reviewer ? { reviewer } : {}) },
      config,
    });

    console.log(
      `jevest: PR #${ref.number} — check=${result.check.conclusion} findings=${result.findingsPublished} cost=$${result.costUsd.toFixed(4)}`,
    );
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
