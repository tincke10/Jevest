/**
 * FindingJudgePort that shells out to `claude -p`, the judge-side twin of
 * ../summarizers/claude-cli-summarizer.ts: same flags, same env stripping,
 * same timeout and error taxonomy, all via ../claude-cli/claude-cli-process.ts.
 * Only the system prompt, the JSON schema and the user message differ.
 *
 * Billed against the Claude subscription (nominal `total_cost_usd`, not
 * cash), which is exactly the H6 comparison: what the filter would cost if
 * an LLM answered the four questions instead of Jev.
 */
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";
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
  JUDGE_OUTPUT_JSON_SCHEMA,
  judgeOutputSchema,
  toFindingJudgment,
} from "./judge-output-schema.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from "./judge-prompt.js";

export interface ClaudeCliFindingJudgeOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5", same as the reviewer. */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

export function createClaudeCliFindingJudge(
  options: ClaudeCliFindingJudgeOptions = {},
): FindingJudgePort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async judge(input: FindingJudgeInput): Promise<FindingJudgeOutput> {
      const args = buildClaudeCliArgs({
        model,
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        jsonSchema: JUDGE_OUTPUT_JSON_SCHEMA,
        userPrompt: buildJudgeUserPrompt(input),
      });

      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const fallbackLatencyMs = now() - start;

      const parsed = parseClaudeCliEnvelope(result, judgeOutputSchema, {
        provider: CLAUDE_CLI_PROVIDER,
        itemId: input.findingId,
        timeoutMs,
        fallbackLatencyMs,
      });

      return {
        judgment: toFindingJudgment(parsed.structuredOutput),
        model,
        usage: parsed.usage,
        latencyMs: parsed.latencyMs,
        nominalCostUsd: parsed.nominalCostUsd,
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      };
    },
  };
}
