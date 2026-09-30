/**
 * DescriptionContextPort that shells out to `claude -p`, the extractor-side
 * twin of ../narrators/claude-cli-narrator.ts: same flags, env stripping,
 * timeout and error taxonomy via ../claude-cli/claude-cli-process.ts.
 */
import type {
  DescriptionContextInput,
  DescriptionContextOutput,
  DescriptionContextPort,
} from "../../domain/ports/description-context-port.js";
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
  DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA,
  descriptionContextOutputSchema,
  toExtractedAuthorContext,
} from "./description-context-output-schema.js";
import {
  DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
  buildDescriptionContextUserPrompt,
} from "./description-context-prompt.js";

export interface ClaudeCliDescriptionContextOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5", same as the reviewer. */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

export function createClaudeCliDescriptionContextExtractor(
  options: ClaudeCliDescriptionContextOptions = {},
): DescriptionContextPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async extract(input: DescriptionContextInput): Promise<DescriptionContextOutput> {
      const args = buildClaudeCliArgs({
        model,
        systemPrompt: DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
        jsonSchema: DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA,
        userPrompt: buildDescriptionContextUserPrompt(input),
      });

      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const fallbackLatencyMs = now() - start;

      const parsed = parseClaudeCliEnvelope(result, descriptionContextOutputSchema, {
        provider: CLAUDE_CLI_PROVIDER,
        itemId: input.prId,
        timeoutMs,
        fallbackLatencyMs,
      });

      return {
        ...toExtractedAuthorContext(parsed.structuredOutput),
        model,
        usage: parsed.usage,
        latencyMs: parsed.latencyMs,
        nominalCostUsd: parsed.nominalCostUsd,
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      };
    },
  };
}
