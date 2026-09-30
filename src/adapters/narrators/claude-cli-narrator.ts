/**
 * ReviewNarratorPort that shells out to `claude -p`, the narrator-side twin
 * of ../summarizers/claude-cli-summarizer.ts: same flags, env stripping,
 * timeout and error taxonomy via ../claude-cli/claude-cli-process.ts. The
 * review comes back as markdown inside a one-field `{review}` schema, so
 * the shared envelope parser and its validation apply unchanged.
 */
import type {
  ReviewNarrativeInput,
  ReviewNarrativeOutput,
  ReviewNarratorPort,
} from "../../domain/ports/review-narrator-port.js";
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
  NARRATIVE_OUTPUT_JSON_SCHEMA,
  narrativeOutputSchema,
  toNarrativeMarkdown,
} from "./narrative-output-schema.js";
import { NARRATIVE_SYSTEM_PROMPT, buildNarrativeUserPrompt } from "./narrative-prompt.js";

export interface ClaudeCliNarratorOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5", same as the reviewer. */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

export function createClaudeCliNarrator(
  options: ClaudeCliNarratorOptions = {},
): ReviewNarratorPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async narrate(input: ReviewNarrativeInput): Promise<ReviewNarrativeOutput> {
      const args = buildClaudeCliArgs({
        model,
        systemPrompt: NARRATIVE_SYSTEM_PROMPT,
        jsonSchema: NARRATIVE_OUTPUT_JSON_SCHEMA,
        userPrompt: buildNarrativeUserPrompt(input),
      });

      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const fallbackLatencyMs = now() - start;

      const parsed = parseClaudeCliEnvelope(result, narrativeOutputSchema, {
        provider: CLAUDE_CLI_PROVIDER,
        itemId: input.prId,
        timeoutMs,
        fallbackLatencyMs,
      });

      return {
        markdown: toNarrativeMarkdown(parsed.structuredOutput),
        model,
        usage: parsed.usage,
        latencyMs: parsed.latencyMs,
        nominalCostUsd: parsed.nominalCostUsd,
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      };
    },
  };
}
