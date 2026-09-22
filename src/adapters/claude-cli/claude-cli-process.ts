/**
 * The `claude -p` (non-interactive Claude Code) process seam shared by every
 * adapter that bills against a Claude subscription instead of Console API
 * credits (SPEC §13). Extracted from ../reviewers/claude-cli-reviewer.ts so
 * the H7 change summarizer runs the exact same flags, env stripping, timeout
 * handling and envelope-to-error mapping; the reviewer keeps its own copy
 * until it is migrated here, on purpose, so its tests stay untouched.
 *
 * Flags, measured (docs/FINDINGS.md "claude-cli prompt-size minimization"):
 * `--safe-mode` stops CLAUDE.md / plugins / hooks from loading (token bloat
 * AND persona leakage into output); `--tools ""` disables tools outright,
 * ~4.3x cheaper than `--disallowedTools`; `--no-session-persistence` so no
 * session lands on disk.
 *
 * `ANTHROPIC_API_KEY` must be ABSENT from the child's env or it shadows the
 * subscription OAuth (verified SPEC decision).
 *
 * The spawn function is always injectable so unit tests never launch a real
 * process; {@link defaultClaudeCliSpawn} wraps `node:child_process.spawn`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { z } from "zod";
import type { ReviewUsage } from "../../domain/ports/reviewer-port.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";

export interface ClaudeCliProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export type ClaudeCliSpawn = (
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<ClaudeCliProcessResult>;

export const CLAUDE_CLI_DEFAULT_MODEL = "claude-opus-5";
export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 180_000;
export const CLAUDE_CLI_PROVIDER = "claude-cli";

const EXCERPT_LEN = 500;

function excerpt(stdout: string, stderr: string): string {
  return `stdout: ${stdout.slice(0, EXCERPT_LEN)} | stderr: ${stderr.slice(0, EXCERPT_LEN)}`;
}

/** True for anything that smells like a rate limit or subscription usage-limit signal. */
function looksLikeRateLimit(apiErrorStatus: unknown, text: string): boolean {
  if (apiErrorStatus === 429) return true;
  return /rate.?limit|usage.?limit|quota/i.test(text);
}

/**
 * A non-zero exit still usually carries a JSON envelope on stdout whose
 * `result` names the real reason (e.g. a usage limit), often past the
 * 500-char excerpt. Classify it: rate-limit signals become
 * ReviewerRateLimitError so callers back off and retry; anything else is a
 * ClaudeCliProcessError whose message leads with that `result` text.
 */
function throwForNonZeroExit(
  result: ClaudeCliProcessResult,
  provider: string,
  rateLimitCheck: (apiErrorStatus: unknown, text: string) => boolean,
): never {
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      envelope = parsed as Record<string, unknown>;
    }
  } catch {
    envelope = null;
  }
  if (envelope === null) {
    throw new ClaudeCliProcessError(result.exitCode, excerpt(result.stdout, result.stderr));
  }
  const resultText = typeof envelope.result === "string" ? envelope.result : "";
  if (rateLimitCheck(envelope.api_error_status, `${resultText} ${result.stderr}`)) {
    throw new ReviewerRateLimitError(provider, envelope);
  }
  const lead = resultText === "" ? "" : `result: ${resultText.slice(0, EXCERPT_LEN)} | `;
  throw new ClaudeCliProcessError(
    result.exitCode,
    `${lead}${excerpt(result.stdout, result.stderr)}`,
  );
}

export function defaultClaudeCliSpawn(
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<ClaudeCliProcessResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn("claude", args as string[], {
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

export interface ClaudeCliArgsInput {
  readonly model: string;
  readonly systemPrompt: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly userPrompt: string;
}

/** The minimal-footprint argv, identical to the reviewer's; the user prompt is always last. */
export function buildClaudeCliArgs(input: ClaudeCliArgsInput): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    input.model,
    "--safe-mode",
    "--tools",
    "",
    "--system-prompt",
    input.systemPrompt,
    "--json-schema",
    JSON.stringify(input.jsonSchema),
    input.userPrompt,
  ];
}

export interface ClaudeCliParseContext {
  readonly provider: string;
  /** The hunk id / PR id, for error messages only. */
  readonly itemId: string;
  readonly timeoutMs: number;
  /** Wall-clock latency measured around the spawn, used when the envelope has no duration_ms. */
  readonly fallbackLatencyMs: number;
}

export interface ClaudeCliParsed<T> {
  readonly structuredOutput: T;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly nominalCostUsd: number;
  readonly sessionId?: string;
}

/**
 * Maps a finished process onto either a validated structured output or one
 * of the typed errors in ../reviewers/reviewer-errors.ts: timeout, non-zero
 * exit, invalid JSON, `is_error` (rate-limit signals become
 * {@link ReviewerRateLimitError} so callers retry uniformly), wrong subtype,
 * missing or schema-invalid `structured_output`.
 */
export function parseClaudeCliEnvelope<T>(
  result: ClaudeCliProcessResult,
  schema: z.ZodType<T>,
  context: ClaudeCliParseContext,
): ClaudeCliParsed<T> {
  if (result.timedOut) {
    throw new ClaudeCliTimeoutError(context.timeoutMs, context.itemId);
  }
  if (result.exitCode !== 0) {
    throwForNonZeroExit(result, context.provider, looksLikeRateLimit);
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new ClaudeCliError(
      `invalid JSON on stdout (${(error as Error).message})`,
      undefined,
      undefined,
      excerpt(result.stdout, result.stderr),
    );
  }

  const apiErrorStatus = envelope.api_error_status;
  const subtype = envelope.subtype;
  const errorText = `${String(envelope.result ?? "")} ${result.stdout} ${result.stderr}`;
  const output = excerpt(result.stdout, result.stderr);

  if (envelope.is_error === true) {
    if (looksLikeRateLimit(apiErrorStatus, errorText)) {
      throw new ReviewerRateLimitError(context.provider, envelope);
    }
    throw new ClaudeCliError("is_error is true", apiErrorStatus, subtype, output);
  }
  if (subtype !== "success") {
    throw new ClaudeCliError(
      `subtype is "${String(subtype)}", not "success"`,
      apiErrorStatus,
      subtype,
      output,
    );
  }
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    throw new ClaudeCliError("structured_output is missing", apiErrorStatus, subtype, output);
  }

  const validated = schema.safeParse(envelope.structured_output);
  if (!validated.success) {
    throw new ClaudeCliError(
      `structured_output failed schema validation (${validated.error.message})`,
      apiErrorStatus,
      subtype,
      output,
    );
  }

  const usage = (envelope.usage as Record<string, unknown> | undefined) ?? {};
  const sessionId = envelope.session_id as string | undefined;

  return {
    structuredOutput: validated.data,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
    },
    latencyMs: Number(envelope.duration_ms ?? context.fallbackLatencyMs),
    nominalCostUsd: Number(envelope.total_cost_usd ?? 0),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
