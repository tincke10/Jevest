/**
 * FindingMatcherPort over `claude -p` (docs/EVAL.md "Matching"): same
 * flags, env stripping, timeout and error taxonomy as every claude-cli
 * adapter (../claude-cli/claude-cli-process.ts: `--safe-mode`, no tools, no
 * session persistence, a JSON schema). A small model by default: the task
 * is "is this finding about one of these few issues", not a review.
 */
import { z } from "zod";
import type {
  FindingMatch,
  FindingMatchInput,
  FindingMatcherPort,
} from "../../domain/ports/finding-matcher-port.js";
import {
  CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
  CLAUDE_CLI_PROVIDER,
  type ClaudeCliSpawn,
  buildClaudeCliArgs,
  defaultClaudeCliSpawn,
  parseClaudeCliEnvelope,
} from "../claude-cli/claude-cli-process.js";
import { ClaudeCliError } from "../reviewers/reviewer-errors.js";

export const CLAUDE_CLI_MATCHER_DEFAULT_MODEL = "claude-sonnet-5";
const NONE = "none";
const MAX_NOTES = 600;
const MAX_CANDIDATE = 3000;

export const MATCHER_SYSTEM_PROMPT = [
  "You compare one code-review finding against a short list of known issues in the same pull request.",
  "Decide which known issue, if any, the finding is ABOUT: the same underlying defect, risk or question, even if worded differently, pinned on a nearby line, or described from its symptom instead of its cause.",
  "A finding about the same file or function but a different problem is NOT a match. When two issues could fit, pick the one whose root cause the finding describes.",
  `Answer with the issue id, or "${NONE}" when the finding is about none of them. Give a one-sentence reason.`,
].join("\n");

const matcherOutputSchema = z.object({
  match: z.string().min(1),
  reason: z.string(),
});

function toPlainJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(matcherOutputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

const MATCHER_OUTPUT_JSON_SCHEMA = toPlainJsonSchema();

function location(file: string | null, line: number | null): string {
  if (file === null) return "(no location)";
  return line === null ? file : `${file}:${line}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildMatcherUserPrompt(input: FindingMatchInput): string {
  const issues = input.goldenIssues.map((issue) => {
    const head = `- ${issue.id} — ${location(issue.file, issue.line)} — ${issue.title}`;
    return issue.notes ? `${head}\n  Evidence: ${clip(issue.notes, MAX_NOTES)}` : head;
  });
  return [
    "Known issues:",
    ...issues,
    "",
    `Finding (${location(input.candidate.file, input.candidate.line)}):`,
    clip(input.candidate.text, MAX_CANDIDATE),
    "",
    `Which known issue id is this finding about? Answer "${NONE}" if none.`,
  ].join("\n");
}

export interface ClaudeCliFindingMatcherOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default {@link CLAUDE_CLI_MATCHER_DEFAULT_MODEL}. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function createClaudeCliFindingMatcher(
  options: ClaudeCliFindingMatcherOptions = {},
): FindingMatcherPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_MATCHER_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async match(input: FindingMatchInput): Promise<FindingMatch> {
      const args = buildClaudeCliArgs({
        model,
        systemPrompt: MATCHER_SYSTEM_PROMPT,
        jsonSchema: MATCHER_OUTPUT_JSON_SCHEMA,
        userPrompt: buildMatcherUserPrompt(input),
      });
      const start = now();
      const result = await spawnFn(args, { timeoutMs });
      const parsed = parseClaudeCliEnvelope(result, matcherOutputSchema, {
        provider: CLAUDE_CLI_PROVIDER,
        itemId: "eval-matcher",
        timeoutMs,
        fallbackLatencyMs: now() - start,
      });
      const answer = parsed.structuredOutput.match.trim();
      if (answer.toLowerCase() === NONE) return { issueId: null, costUsd: parsed.nominalCostUsd };
      if (!input.goldenIssues.some((issue) => issue.id === answer)) {
        throw new ClaudeCliError(
          `matcher answered "${answer}", which is not one of the offered issue ids`,
          undefined,
          undefined,
          "",
        );
      }
      return { issueId: answer, costUsd: parsed.nominalCostUsd };
    },
  };
}
