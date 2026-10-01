/**
 * FindingVerifierPort over `claude -p` (`reviewer.verifier: claude-cli`):
 * a FRESH agent per finding, same read-only tools and deny list as the
 * reviewer (../claude-cli/claude-cli-agent.ts), a small turn cap, asked to
 * refute the finding, decision first. The reason and quotes come back
 * redacted.
 */
import type {
  FindingVerificationInput,
  FindingVerificationOutput,
  FindingVerifierPort,
} from "../../domain/ports/finding-verifier-port.js";
import { redact } from "../../domain/redact.js";
import {
  type AgentSpawn,
  defaultAgentSpawn,
  runClaudeCliAgent,
} from "../claude-cli/claude-cli-agent.js";
import {
  FINDING_VERIFICATION_JSON_SCHEMA,
  findingVerificationSchema,
} from "./agentic-output-schema.js";
import {
  FINDING_VERIFIER_SYSTEM_PROMPT,
  buildFindingVerifierUserPrompt,
} from "./agentic-prompt.js";

/** `reviewer.verifierModel` default. */
export const VERIFIER_DEFAULT_MODEL = "claude-sonnet-5";
/** `reviewer.agentic.verifierMaxTurns` default. */
export const VERIFIER_DEFAULT_MAX_TURNS = 12;
/** `reviewer.agentic.verifierTimeoutMs` default: 5 minutes. */
export const VERIFIER_DEFAULT_TIMEOUT_MS = 300_000;

export interface ClaudeCliFindingVerifierOptions {
  readonly spawn?: AgentSpawn;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function createClaudeCliFindingVerifier(
  options: ClaudeCliFindingVerifierOptions = {},
): FindingVerifierPort {
  const model = options.model ?? VERIFIER_DEFAULT_MODEL;
  return {
    async verify(input: FindingVerificationInput): Promise<FindingVerificationOutput> {
      const run = await runClaudeCliAgent({
        spawn: options.spawn ?? defaultAgentSpawn,
        model,
        systemPrompt: FINDING_VERIFIER_SYSTEM_PROMPT,
        jsonSchema: FINDING_VERIFICATION_JSON_SCHEMA,
        maxTurns: options.maxTurns ?? VERIFIER_DEFAULT_MAX_TURNS,
        cwd: input.repoRoot,
        stdin: buildFindingVerifierUserPrompt(input),
        timeoutMs: options.timeoutMs ?? VERIFIER_DEFAULT_TIMEOUT_MS,
        schema: findingVerificationSchema,
        itemId: input.itemId,
        now: options.now ?? Date.now,
      });
      const out = run.structuredOutput;
      return {
        ...run.info,
        decision: out.decision,
        reason: redact(out.reason).text,
        evidence: out.evidence.map((e) => ({
          ...e,
          quote: redact(e.quote, { path: e.file }).text,
        })),
      };
    },
  };
}
