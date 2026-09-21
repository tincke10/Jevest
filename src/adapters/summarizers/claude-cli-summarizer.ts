/**
 * ChangeSummarizerPort that shells out to `claude -p`, the summarizer-side
 * twin of ../reviewers/claude-cli-reviewer.ts: same flags, same env
 * stripping, same timeout and the same error taxonomy, all via
 * ../claude-cli/claude-cli-process.ts. Only the system prompt, the JSON
 * schema and the user message differ.
 *
 * The user message is built from files and patches only; the PR id is used
 * for error messages and never reaches the CLI (see the port for why the
 * summarizer must not see the author's narrative).
 */
import type {
  ChangeSummarizerPort,
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import {
  CLAUDE_CLI_DEFAULT_MODEL,
  CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
  CLAUDE_CLI_PROVIDER,
  type ClaudeCliSpawn,
  buildClaudeCliArgs,
  defaultClaudeCliSpawn,
  parseClaudeCliEnvelope,
} from "../claude-cli/claude-cli-process.js";
import {
  SUMMARY_OUTPUT_JSON_SCHEMA,
  summaryOutputSchema,
  toChangeSummary,
} from "./summary-output-schema.js";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt } from "./summary-prompt.js";

export interface ClaudeCliSummarizerOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5", same as the reviewer. */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

export function createClaudeCliSummarizer(
  options: ClaudeCliSummarizerOptions = {},
): ChangeSummarizerPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      const args = buildClaudeCliArgs({
        model,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        jsonSchema: SUMMARY_OUTPUT_JSON_SCHEMA,
        userPrompt: buildSummaryUserPrompt(input),
      });

      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const fallbackLatencyMs = now() - start;

      const parsed = parseClaudeCliEnvelope(result, summaryOutputSchema, {
        provider: CLAUDE_CLI_PROVIDER,
        itemId: input.prId,
        timeoutMs,
        fallbackLatencyMs,
      });

      return {
        summary: toChangeSummary(parsed.structuredOutput),
        model,
        usage: parsed.usage,
        latencyMs: parsed.latencyMs,
        nominalCostUsd: parsed.nominalCostUsd,
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      };
    },
  };
}
