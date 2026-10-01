/**
 * FindingMatcherPort over `claude -p` (docs/EVAL.md "Matching"): same
 * flags, env stripping, timeout and error taxonomy as every claude-cli
 * adapter (../claude-cli/claude-cli-process.ts: `--safe-mode`, no tools, no
 * session persistence, a JSON schema), plus an explicit `--effort`.
 *
 * Opus at medium effort by default: an adjudicator found the cheaper
 * matcher pairing findings with the wrong issue of the same file when the
 * titles shared words. The model now sees each issue's notes, category and
 * verdict and the finding's claim, failing scenario and evidence quotes,
 * and answers decision-first (`match`, `sameRootCause`, then `reason`); a
 * match it does not call the same root cause counts as none.
 */
import { z } from "zod";
import type {
  FindingMatch,
  FindingMatchInput,
  FindingMatcherPort,
  MatchableIssue,
} from "../../domain/ports/finding-matcher-port.js";
import {
  CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
  CLAUDE_CLI_PROVIDER,
  type ClaudeCliSpawn,
  buildClaudeCliArgs,
  defaultClaudeCliSpawn,
  parseClaudeCliEnvelope,
} from "../claude-cli/claude-cli-process.js";
import type { AgentEffort } from "../config/jevest-config.js";
import { ClaudeCliError } from "../reviewers/reviewer-errors.js";

export const CLAUDE_CLI_MATCHER_DEFAULT_MODEL = "claude-opus-5-5";
export const CLAUDE_CLI_MATCHER_DEFAULT_EFFORT: AgentEffort = "medium";
export const MATCHER_NOTES_MAX = 400;
const NONE = "none";
const MAX_CANDIDATE = 3000;
const MAX_QUOTE = 300;
const MAX_QUOTES = 5;

export const MATCHER_SAME_PROBLEM_RULE = `Match only when the finding is about the SAME underlying problem as the issue (same root cause and same consequence), not merely the same file or similar words; prefer "${NONE}" when unsure.`;

export const MATCHER_SYSTEM_PROMPT = [
  "You compare one code-review finding against a short list of known issues in the same pull request.",
  "Decide which known issue, if any, the finding is ABOUT. Read each issue's notes: they say what the problem actually is.",
  MATCHER_SAME_PROBLEM_RULE,
  "The same defect worded differently, pinned on a nearby line or a caller, or described from its symptom instead of its cause IS a match. A different problem in the same file or function, or one that only shares words with an issue's title, is NOT.",
  "When two issues could fit, pick the one whose root cause the finding describes.",
  `Answer first: "match" is the issue id or "${NONE}"; "sameRootCause" is true only if the finding and that issue share the root cause (false with "${NONE}"); then a one-sentence "reason".`,
].join("\n");

const matcherOutputSchema = z.object({
  match: z.string().min(1),
  sameRootCause: z.boolean(),
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
  return line === null || line === 0 ? file : `${file}:${line}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function issueLine(issue: MatchableIssue): string {
  const tags = [issue.verdict, issue.category].filter((t): t is string => Boolean(t));
  const places =
    issue.file === null && (issue.locations ?? []).length === 0
      ? "(no location)"
      : [
          ...(issue.file !== null ? [location(issue.file, issue.line)] : []),
          ...(issue.locations ?? []).map((l) => location(l.file, l.line)),
        ].join(", ");
  const head = `- ${issue.id}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""} ${places} — ${issue.title}`;
  return issue.notes ? `${head}\n  Notes: ${clip(issue.notes, MATCHER_NOTES_MAX)}` : head;
}

export function buildMatcherUserPrompt(input: FindingMatchInput): string {
  const { candidate } = input;
  const lines = [
    "Known issues:",
    ...input.goldenIssues.map(issueLine),
    "",
    `Finding at ${location(candidate.file, candidate.line)}`,
    `Claim: ${clip(candidate.claim ?? candidate.text, MAX_CANDIDATE)}`,
  ];
  if (candidate.failingScenario) {
    lines.push(`Failing scenario: ${clip(candidate.failingScenario, MAX_CANDIDATE)}`);
  }
  const evidence = (candidate.evidence ?? []).slice(0, MAX_QUOTES);
  if (evidence.length > 0) {
    lines.push(
      "Evidence:",
      ...evidence.map((e) => `- ${location(e.file, e.line)}: ${clip(e.quote, MAX_QUOTE)}`),
    );
  }
  lines.push(
    "",
    `Which known issue is this finding about — the same root cause and consequence? Answer "${NONE}" if none or unsure.`,
  );
  return lines.join("\n");
}

export interface ClaudeCliFindingMatcherOptions {
  /** Injectable for tests; default wraps `node:child_process.spawn("claude", ...)`. */
  readonly spawn?: ClaudeCliSpawn;
  /** Default {@link CLAUDE_CLI_MATCHER_DEFAULT_MODEL}. */
  readonly model?: string;
  /** Default {@link CLAUDE_CLI_MATCHER_DEFAULT_EFFORT}. */
  readonly effort?: AgentEffort;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function createClaudeCliFindingMatcher(
  options: ClaudeCliFindingMatcherOptions = {},
): FindingMatcherPort {
  const spawnFn = options.spawn ?? defaultClaudeCliSpawn;
  const model = options.model ?? CLAUDE_CLI_MATCHER_DEFAULT_MODEL;
  const effort = options.effort ?? CLAUDE_CLI_MATCHER_DEFAULT_EFFORT;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async match(input: FindingMatchInput): Promise<FindingMatch> {
      const args = buildClaudeCliArgs({
        model,
        effort,
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
      const { match, sameRootCause, reason } = parsed.structuredOutput;
      const answer = match.trim();
      const costUsd = parsed.nominalCostUsd;
      if (answer.toLowerCase() === NONE) return { issueId: null, costUsd, reason };
      if (!input.goldenIssues.some((issue) => issue.id === answer)) {
        throw new ClaudeCliError(
          `matcher answered "${answer}", which is not one of the offered issue ids`,
          undefined,
          undefined,
          "",
        );
      }
      // Decision-first guard: an id without the same root cause is a
      // same-file / similar-words pick the rule says to drop.
      if (!sameRootCause) return { issueId: null, costUsd, reason };
      return { issueId: answer, costUsd, reason };
    },
  };
}
