/**
 * The read-only `claude -p` AGENT seam (`reviewer.mode: agentic`): the
 * reviewer and the optional verifier run Claude Code with cwd = a checkout
 * of the PR head and only the Read, Grep and Glob tools. Same subscription
 * billing and env stripping as ./claude-cli-process.ts; different flags,
 * because here the model is SUPPOSED to use tools.
 *
 * Flags, verified on Claude Code 2.1.286 with a real run against a temp
 * dir holding fake secrets (see claude-cli-agent.integration.test.ts):
 *
 * - `--tools Read,Grep,Glob`: the only built-in tools that exist in the
 *   session (the init event lists exactly these plus StructuredOutput).
 * - `--allowedTools Read,Grep,Glob` + `--permission-mode dontAsk` +
 *   `--permission-prompts none`: those three run without a prompt;
 *   anything that would prompt is denied, nobody is asked.
 * - `--restricted`: confines the file tools to the working directory.
 *   Without it a Read of an absolute path OUTSIDE the checkout succeeded
 *   in the test; with it the call is refused ("is outside ..."). It also
 *   ignores user/project/local settings files (managed settings and
 *   `--settings` still apply), so the repo under review cannot loosen the
 *   rules with its own `.claude/settings.json`.
 * - `--settings '<json>'` with `permissions.deny`: `Read(<pattern>)` rules
 *   for {@link AGENT_DENIED_READ_PATTERNS}. Verified: a denied Read fails
 *   ("denied by your permission settings") and Grep skips denied files
 *   (a search for a value inside `.env` returned no matches). The denied
 *   tools are listed too, defense in depth over `--tools`.
 * - `--safe-mode`: no CLAUDE.md, hooks, plugins, skills or MCP servers
 *   from the machine or the repo; `--strict-mcp-config` on top.
 * - `--max-turns <n>`: not in `--help` but accepted; a run that reaches it
 *   exits 1 with a result event `subtype: "error_max_turns"`.
 * - `--output-format stream-json --verbose`: one JSON event per line, so
 *   every tool call is visible (the read-only audit in the run log); the
 *   final `result` event carries `structured_output` exactly like the
 *   `json` format's envelope.
 * - `--json-schema`, `--model`, `--no-session-persistence` as elsewhere.
 *
 * The user prompt goes on STDIN, never in argv: a PR diff easily exceeds
 * Linux's 128 KiB limit on a single argument.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { z } from "zod";
import type { AgentRunInfo, AgentToolCall } from "../../domain/ports/agentic-reviewer-port.js";
import { ClaudeCliError, ClaudeCliTimeoutError } from "../reviewers/reviewer-errors.js";
import {
  CLAUDE_CLI_PROVIDER,
  type ClaudeCliProcessResult,
  parseClaudeCliEnvelope,
} from "./claude-cli-process.js";

export const AGENT_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Never available to the agent: writes, code execution, network, sub-agents. */
export const AGENT_DENIED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
] as const;

/**
 * Paths the agent may never read, as permission-rule patterns relative to
 * the checkout (`./x` = the root, `**` = any depth). `.git` is in the list
 * because `actions/checkout` persists the job's token in `.git/config`.
 */
export const AGENT_DENIED_READ_PATTERNS = [
  "./.env*",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/secrets/**",
  "**/credentials*",
  "./storage/**",
  "./vendor/**",
  "**/node_modules/**",
  "./.git/**",
] as const;

export interface AgentPermissionSettings {
  readonly permissions: { readonly deny: readonly string[] };
}

export function agentPermissionSettings(): AgentPermissionSettings {
  return {
    permissions: {
      deny: [...AGENT_DENIED_READ_PATTERNS.map((p) => `Read(${p})`), ...AGENT_DENIED_TOOLS],
    },
  };
}

export interface ClaudeCliAgentArgsInput {
  readonly model: string;
  readonly systemPrompt: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxTurns: number;
}

/** The verified argv (see the module doc). No positional prompt: it goes on stdin. */
export function buildClaudeCliAgentArgs(input: ClaudeCliAgentArgsInput): string[] {
  const tools = AGENT_READ_ONLY_TOOLS.join(",");
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    input.model,
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--settings",
    JSON.stringify(agentPermissionSettings()),
    "--max-turns",
    String(input.maxTurns),
    "--system-prompt",
    input.systemPrompt,
    "--json-schema",
    JSON.stringify(input.jsonSchema),
  ];
}

export type AgentSpawn = (
  args: readonly string[],
  options: { readonly cwd: string; readonly stdin: string; readonly timeoutMs: number },
) => Promise<ClaudeCliProcessResult>;

export function defaultAgentSpawn(
  args: readonly string[],
  options: { readonly cwd: string; readonly stdin: string; readonly timeoutMs: number },
): Promise<ClaudeCliProcessResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn("claude", args as string[], {
      cwd: options.cwd,
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
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: null, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin.on("error", () => {
      // The child may exit before reading stdin; its exit code says why.
    });
    child.stdin.end(options.stdin);
  });
}

export interface ParsedAgentStream {
  /** The final `result` event, or `null` when the stream has none. */
  readonly result: Record<string, unknown> | null;
  /** Every tool call except the StructuredOutput answer, in order. */
  readonly toolCalls: readonly AgentToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function targetOf(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const str = (key: string): string | null =>
    typeof input[key] === "string" ? (input[key] as string) : null;
  const filePath = str("file_path");
  if (filePath !== null) return filePath;
  const pattern = str("pattern");
  const path = str("path");
  if (pattern !== null && path !== null) return `${pattern} @ ${path}`;
  return pattern ?? path;
}

const DENIED_RESULT_RE =
  /denied by your permission settings|is outside |permission to use .* has been denied|not allowed/i;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

/** Reads a `stream-json` stdout (see the module doc); tolerant of non-JSON lines. */
export function parseAgentStream(stdout: string): ParsedAgentStream {
  const calls: { id: string; tool: string; target: string | null }[] = [];
  const deniedIds = new Set<string>();
  let result: Record<string, unknown> | null = null;
  for (const raw of stdout.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "result") {
      result = event;
      if (Array.isArray(event.permission_denials)) {
        for (const denial of event.permission_denials) {
          if (isRecord(denial) && typeof denial.tool_use_id === "string") {
            deniedIds.add(denial.tool_use_id);
          }
        }
      }
      continue;
    }
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        if (block.name === "StructuredOutput") continue;
        calls.push({ id: String(block.id ?? ""), tool: block.name, target: targetOf(block.input) });
      } else if (block.type === "tool_result" && block.is_error === true) {
        if (DENIED_RESULT_RE.test(resultText(block.content))) {
          deniedIds.add(String(block.tool_use_id ?? ""));
        }
      }
    }
  }
  return {
    result,
    toolCalls: calls.map((call) => ({
      tool: call.tool,
      target: call.target,
      denied: deniedIds.has(call.id),
    })),
  };
}

export interface RunClaudeCliAgentInput<T> extends ClaudeCliAgentArgsInput {
  readonly spawn: AgentSpawn;
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly schema: z.ZodType<T>;
  /** For error messages only. */
  readonly itemId: string;
  readonly now: () => number;
}

export interface ClaudeCliAgentRun<T> {
  readonly structuredOutput: T;
  readonly info: AgentRunInfo;
}

const STOPPED_SUBTYPES = new Set([
  "error_max_turns",
  "error_max_budget_usd",
  "error_during_execution",
]);

/** One agent run end to end: spawn, read the stream, validate the answer. */
export async function runClaudeCliAgent<T>(
  input: RunClaudeCliAgentInput<T>,
): Promise<ClaudeCliAgentRun<T>> {
  const args = buildClaudeCliAgentArgs(input);
  const start = input.now();
  const processResult = await input.spawn(args, {
    cwd: input.cwd,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
  });
  const fallbackLatencyMs = input.now() - start;
  if (processResult.timedOut) {
    throw new ClaudeCliTimeoutError(input.timeoutMs, input.itemId);
  }
  const stream = parseAgentStream(processResult.stdout);
  const subtype = stream.result?.subtype;
  if (typeof subtype === "string" && STOPPED_SUBTYPES.has(subtype)) {
    throw new ClaudeCliError(
      `the agent stopped before answering (${subtype}, ${String(stream.result?.num_turns ?? "?")} turns)`,
      stream.result?.api_error_status,
      subtype,
      processResult.stderr.slice(0, 500),
    );
  }
  const parsed = parseClaudeCliEnvelope(
    {
      ...processResult,
      stdout: stream.result === null ? processResult.stdout : JSON.stringify(stream.result),
    },
    input.schema,
    {
      provider: CLAUDE_CLI_PROVIDER,
      itemId: input.itemId,
      timeoutMs: input.timeoutMs,
      fallbackLatencyMs,
    },
  );
  return {
    structuredOutput: parsed.structuredOutput,
    info: {
      model: input.model,
      usage: parsed.usage,
      latencyMs: parsed.latencyMs,
      nominalCostUsd: parsed.nominalCostUsd,
      turns: Number(stream.result?.num_turns ?? 0),
      toolCalls: stream.toolCalls,
    },
  };
}
