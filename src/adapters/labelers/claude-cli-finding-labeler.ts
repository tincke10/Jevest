/**
 * FindingLabelerPort that shells out to `claude -p`, the labeler-side twin of
 * ../judges/claude-cli-finding-judge.ts: same flags, same env stripping, same
 * timeout and error taxonomy, all via ../claude-cli/claude-cli-process.ts.
 * Only the system prompt, the JSON schema and the user message differ.
 *
 * It exists for H1b (datasets/FINDINGS.md §11): the reversed dataset needs a
 * fresh oracle label and the DeepSeek balance ran out mid-run on the first
 * one. Billed against the Claude subscription (nominal `total_cost_usd`, not
 * cash), like the reviewer.
 *
 * It answers the SAME two framings as ./deepseek-finding-labeler.ts, from the
 * same shared prompts in ./labeler-prompt.ts, so a label from either adapter
 * means the same thing. The one difference is structure enforcement: DeepSeek
 * gets json-mode plus a hand-written format suffix and is validated
 * client-side; here `--json-schema` carries the framing's own verdict
 * vocabulary, so a pass that answered as the other framing is a loud schema
 * failure, never a coerced verdict.
 *
 * The two adapters must never share a recorded fixture — see
 * `labelerId` on ./recorded-finding-labeler.ts.
 */
import type { z } from "zod";
import type {
  ClaimVerificationOutput,
  FindingLabelerInput,
  FindingLabelerPort,
  FixMatchOutput,
  LabelerCallOutput,
  LabelerFraming,
} from "../../domain/ports/finding-labeler-port.js";
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
  claimVerificationOutputSchema,
  fixMatchOutputSchema,
  labelerOutputJsonSchemaFor,
} from "./labeler-output-schema.js";
import { buildLabelerUserPrompt, labelerSystemPromptFor } from "./labeler-prompt.js";

/** Identifies this adapter's fixtures, so a DeepSeek label never replays for a claude-cli run. */
export const CLAUDE_CLI_LABELER_ID = "claude-cli";

export interface ClaudeCliFindingLabelerOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default "claude-opus-5", same as the reviewer and the judge. */
  readonly model?: string;
  /** Default 180_000 (3 minutes); the child is killed if it runs longer. */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic latency fallback. Default: `Date.now`. */
  readonly now?: () => number;
}

export function createClaudeCliFindingLabeler(
  options: ClaudeCliFindingLabelerOptions = {},
): FindingLabelerPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  // The schema is passed in rather than looked up from `framing`, so each
  // call site carries one concrete verdict vocabulary: a fix-match call can
  // never be typed as accepting a claim-verification answer.
  async function call<V extends string>(
    input: FindingLabelerInput,
    framing: LabelerFraming,
    schema: z.ZodType<{ verdict: V; confidence: number; reason: string }>,
  ): Promise<LabelerCallOutput<V>> {
    const args = buildClaudeCliArgs({
      model,
      systemPrompt: labelerSystemPromptFor(framing),
      jsonSchema: labelerOutputJsonSchemaFor(framing),
      userPrompt: buildLabelerUserPrompt(input),
    });

    const start = now();
    const result = await spawnFn(args, { timeoutMs });
    const fallbackLatencyMs = now() - start;

    const parsed = parseClaudeCliEnvelope(result, schema, {
      provider: CLAUDE_CLI_PROVIDER,
      itemId: input.findingId,
      timeoutMs,
      fallbackLatencyMs,
    });

    return {
      framing,
      verdict: parsed.structuredOutput.verdict,
      confidence: parsed.structuredOutput.confidence,
      reason: parsed.structuredOutput.reason,
      model,
      usage: parsed.usage,
      latencyMs: parsed.latencyMs,
      nominalCostUsd: parsed.nominalCostUsd,
      ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
    };
  }

  return {
    async labelFixMatch(input: FindingLabelerInput): Promise<FixMatchOutput> {
      return call(input, "fix-match", fixMatchOutputSchema);
    },
    async labelClaimVerification(input: FindingLabelerInput): Promise<ClaimVerificationOutput> {
      return call(input, "claim-verification", claimVerificationOutputSchema);
    },
  };
}
