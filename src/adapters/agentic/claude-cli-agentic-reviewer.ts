/**
 * AgenticReviewerPort over `claude -p` (see ../claude-cli/claude-cli-agent.ts
 * for the verified read-only flags and the deny list): one agent per pull
 * request, cwd = the checkout of the PR head, the static system prompt,
 * the PR on stdin. Findings come back redacted (NFR-3 on the way out).
 */
import { redactAgenticFinding } from "../../domain/agentic-finding.js";
import type {
  AgenticReviewInput,
  AgenticReviewOutput,
  AgenticReviewerPort,
} from "../../domain/ports/agentic-reviewer-port.js";
import {
  type AgentSpawn,
  defaultAgentSpawn,
  runClaudeCliAgent,
} from "../claude-cli/claude-cli-agent.js";
import { CLAUDE_CLI_DEFAULT_MODEL } from "../claude-cli/claude-cli-process.js";
import {
  AGENTIC_REVIEW_JSON_SCHEMA,
  agenticReviewOutputSchema,
  toAgenticFindings,
} from "./agentic-output-schema.js";
import { AGENTIC_REVIEW_SYSTEM_PROMPT, buildAgenticReviewUserPrompt } from "./agentic-prompt.js";

/** `reviewer.agentic.maxTurns` default. */
export const AGENTIC_DEFAULT_MAX_TURNS = 40;
/** `reviewer.agentic.timeoutMs` default: 15 minutes. */
export const AGENTIC_DEFAULT_TIMEOUT_MS = 900_000;

export interface ClaudeCliAgenticReviewerOptions {
  readonly spawn?: AgentSpawn;
  /** Default "claude-opus-5". */
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function createClaudeCliAgenticReviewer(
  options: ClaudeCliAgenticReviewerOptions = {},
): AgenticReviewerPort {
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  return {
    async reviewPullRequest(input: AgenticReviewInput): Promise<AgenticReviewOutput> {
      const run = await runClaudeCliAgent({
        spawn: options.spawn ?? defaultAgentSpawn,
        model,
        systemPrompt: AGENTIC_REVIEW_SYSTEM_PROMPT,
        jsonSchema: AGENTIC_REVIEW_JSON_SCHEMA,
        maxTurns: options.maxTurns ?? AGENTIC_DEFAULT_MAX_TURNS,
        cwd: input.repoRoot,
        stdin: buildAgenticReviewUserPrompt(input),
        timeoutMs: options.timeoutMs ?? AGENTIC_DEFAULT_TIMEOUT_MS,
        schema: agenticReviewOutputSchema,
        itemId: input.prId,
        now: options.now ?? Date.now,
      });
      return {
        ...run.info,
        findings: toAgenticFindings(run.structuredOutput).map(redactAgenticFinding),
      };
    },
  };
}
