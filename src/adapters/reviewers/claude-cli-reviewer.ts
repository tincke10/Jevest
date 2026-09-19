/**
 * ReviewerPort that shells out to `claude -p` (non-interactive Claude Code),
 * so review calls draw from a Claude Max subscription instead of Anthropic
 * Console API credits (SPEC §13, 2026-09-19 decision: no Console credits,
 * subscription + `claude -p` confirmed by Anthropic's help center to bill
 * against it in your own projects).
 *
 * Flags, measured (see docs/FINDINGS.md "claude-cli prompt-size
 * minimization" for the full table): `--safe-mode` disables CLAUDE.md /
 * plugin / hook auto-loading, which both cuts token bloat ~25x AND (more
 * importantly for correctness) stops this repo's own CLAUDE.md persona from
 * leaking into review output — confirmed by a real call that, without
 * --safe-mode, answered a neutral prompt in-character ("dude", project
 * gossip) despite a fully custom --system-prompt. `--tools ""` (disable all
 * tools outright) beats `--disallowedTools <list>` (which still ships full
 * tool schemas, just blocks invocation) by ~4.3x on total tokens.
 * `--exclude-dynamic-system-prompt-sections` is a no-op here: the CLI's own
 * help text says it's "ignored with --system-prompt", confirmed by an
 * identical token count in the measurement.
 *
 * `ANTHROPIC_API_KEY` must be ABSENT from the child's env or it shadows the
 * subscription OAuth (SPEC decision — verified fact, not re-derived here).
 *
 * The spawn function is always injectable so unit tests never launch a real
 * process; the default implementation wraps `node:child_process.spawn`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import {
  REVIEW_OUTPUT_JSON_SCHEMA,
  reviewOutputSchema,
  toReviewFindingCandidates,
} from "./review-output-schema.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./review-prompt.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "./reviewer-errors.js";

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

export interface ClaudeCliReviewerOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5". */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIMEOUT_MS = 180_000;
const PROVIDER = "claude-cli";
const EXCERPT_LEN = 500;

function excerpt(stdout: string, stderr: string): string {
  return `stdout: ${stdout.slice(0, EXCERPT_LEN)} | stderr: ${stderr.slice(0, EXCERPT_LEN)}`;
}

/** True for anything that smells like a rate limit or subscription usage-limit signal. */
function looksLikeRateLimit(apiErrorStatus: unknown, text: string): boolean {
  if (apiErrorStatus === 429) return true;
  return /rate.?limit|usage.?limit|quota/i.test(text);
}

function defaultSpawn(
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

export function createClaudeCliReviewer(options: ClaudeCliReviewerOptions = {}): ReviewerPort {
  const spawnFn = options.spawn ?? defaultSpawn;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--model",
        model,
        "--safe-mode",
        "--tools",
        "",
        "--system-prompt",
        REVIEW_SYSTEM_PROMPT,
        "--json-schema",
        JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA),
        buildReviewUserPrompt(input),
      ];

      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const fallbackLatencyMs = now() - start;

      if (result.timedOut) {
        throw new ClaudeCliTimeoutError(timeoutMs, input.hunkId);
      }
      if (result.exitCode !== 0) {
        throw new ClaudeCliProcessError(result.exitCode, excerpt(result.stdout, result.stderr));
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

      if (envelope.is_error === true) {
        if (looksLikeRateLimit(apiErrorStatus, errorText)) {
          throw new ReviewerRateLimitError(PROVIDER, envelope);
        }
        throw new ClaudeCliError(
          "is_error is true",
          apiErrorStatus,
          subtype,
          excerpt(result.stdout, result.stderr),
        );
      }
      if (subtype !== "success") {
        throw new ClaudeCliError(
          `subtype is "${String(subtype)}", not "success"`,
          apiErrorStatus,
          subtype,
          excerpt(result.stdout, result.stderr),
        );
      }
      if (envelope.structured_output === undefined || envelope.structured_output === null) {
        throw new ClaudeCliError(
          "structured_output is missing",
          apiErrorStatus,
          subtype,
          excerpt(result.stdout, result.stderr),
        );
      }

      const validated = reviewOutputSchema.safeParse(envelope.structured_output);
      if (!validated.success) {
        throw new ClaudeCliError(
          `structured_output failed schema validation (${validated.error.message})`,
          apiErrorStatus,
          subtype,
          excerpt(result.stdout, result.stderr),
        );
      }

      const usage = (envelope.usage as Record<string, unknown> | undefined) ?? {};
      const sessionId = envelope.session_id as string | undefined;

      return {
        findings: toReviewFindingCandidates(validated.data),
        model,
        usage: {
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
          cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
        },
        latencyMs: Number(envelope.duration_ms ?? fallbackLatencyMs),
        nominalCostUsd: Number(envelope.total_cost_usd ?? 0),
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    },
  };
}
