import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeCliError, ClaudeCliTimeoutError } from "../reviewers/reviewer-errors.js";
import {
  AGENT_DENIED_READ_PATTERNS,
  AGENT_DENIED_TOOLS,
  AGENT_READ_ONLY_TOOLS,
  type AgentSpawn,
  agentPermissionSettings,
  buildClaudeCliAgentArgs,
  parseAgentStream,
  runClaudeCliAgent,
} from "./claude-cli-agent.js";

const schema = z.object({ ok: z.boolean() });

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function resultEvent(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    num_turns: 4,
    duration_ms: 1234,
    total_cost_usd: 0.42,
    session_id: "s-1",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    structured_output: { ok: true },
    permission_denials: [],
    ...overrides,
  });
}

function stream(...events: string[]): string {
  return `${events.join("\n")}\n`;
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, isError: boolean, content: string) =>
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });

describe("agent permissions", () => {
  it("allows only Read, Grep and Glob", () => {
    expect(AGENT_READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("denies every tool that writes, runs code, reaches the network or spawns agents", () => {
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task", "NotebookEdit"]) {
      expect(AGENT_DENIED_TOOLS).toContain(tool);
    }
  });

  it("denies reading env files, keys, credentials, secrets dirs, .git and vendored dirs", () => {
    for (const pattern of [
      "./.env*",
      "**/.env*",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/id_rsa*",
      "**/secrets/**",
      "**/credentials*",
      "./storage/**",
      "./vendor/**",
      "**/node_modules/**",
      "./.git/**",
    ]) {
      expect(AGENT_DENIED_READ_PATTERNS).toContain(pattern);
    }
  });

  it("puts every denied path as a Read(...) rule and every denied tool in the settings deny list", () => {
    const settings = agentPermissionSettings();
    expect(settings.permissions.deny).toEqual([
      ...AGENT_DENIED_READ_PATTERNS.map((p) => `Read(${p})`),
      ...AGENT_DENIED_TOOLS,
    ]);
  });
});

describe("buildClaudeCliAgentArgs", () => {
  it("emits the verified read-only, non-interactive flags; the prompt goes on stdin, never in argv", () => {
    const args = buildClaudeCliAgentArgs({
      model: "m",
      systemPrompt: "sys",
      jsonSchema: { type: "object" },
      maxTurns: 40,
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--model",
      "m",
      "--safe-mode",
      "--restricted",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--settings",
      JSON.stringify(agentPermissionSettings()),
      "--max-turns",
      "40",
      "--system-prompt",
      "sys",
      "--json-schema",
      '{"type":"object"}',
    ]);
  });
});

describe("parseAgentStream", () => {
  it("finds the result event and lists every tool call with its target", () => {
    const parsed = parseAgentStream(
      stream(
        line({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] }),
        toolUse("t1", "Read", { file_path: "/repo/src/a.ts" }),
        toolResult("t1", false, "1\tcode"),
        toolUse("t2", "Grep", { pattern: "foo", path: "." }),
        toolResult("t2", false, "No matches found"),
        toolUse("t3", "Glob", { pattern: "**/*.ts" }),
        toolUse("t4", "StructuredOutput", { ok: true }),
        resultEvent(),
      ),
    );
    expect(parsed.result).toMatchObject({ subtype: "success", num_turns: 4 });
    expect(parsed.toolCalls).toEqual([
      { tool: "Read", target: "/repo/src/a.ts", denied: false },
      { tool: "Grep", target: "foo @ .", denied: false },
      { tool: "Glob", target: "**/*.ts", denied: false },
    ]);
  });

  it("marks a call the permission layer refused as denied", () => {
    const parsed = parseAgentStream(
      stream(
        toolUse("t1", "Read", { file_path: "/repo/.env" }),
        toolResult(
          "t1",
          true,
          "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>",
        ),
        toolUse("t2", "Read", { file_path: "/outside.txt" }),
        toolResult("t2", true, "/outside.txt is outside /repo"),
        resultEvent({
          permission_denials: [{ tool_name: "Read", tool_use_id: "t2", tool_input: {} }],
        }),
      ),
    );
    expect(parsed.toolCalls).toEqual([
      { tool: "Read", target: "/repo/.env", denied: true },
      { tool: "Read", target: "/outside.txt", denied: true },
    ]);
  });

  it("ignores lines that are not JSON and returns a null result when there is none", () => {
    const parsed = parseAgentStream("not json\n{\n");
    expect(parsed.result).toBeNull();
    expect(parsed.toolCalls).toEqual([]);
  });
});

describe("runClaudeCliAgent", () => {
  function spawnReturning(
    stdout: string,
    extra: Partial<{ exitCode: number; timedOut: boolean }> = {},
  ) {
    const calls: { args: readonly string[]; cwd: string; stdin: string; timeoutMs: number }[] = [];
    const spawn: AgentSpawn = async (args, options) => {
      calls.push({ args, ...options });
      return {
        stdout,
        stderr: "",
        exitCode: extra.exitCode ?? 0,
        timedOut: extra.timedOut ?? false,
      };
    };
    return { spawn, calls };
  }

  const base = {
    model: "m",
    systemPrompt: "sys",
    jsonSchema: { type: "object" },
    maxTurns: 7,
    cwd: "/repo",
    stdin: "the prompt",
    timeoutMs: 1000,
    schema,
    itemId: "acme/w#1",
    now: () => 0,
  };

  it("runs in the given cwd with the prompt on stdin and returns output, usage, turns, cost and tool calls", async () => {
    const { spawn, calls } = spawnReturning(
      stream(toolUse("t1", "Read", { file_path: "a.ts" }), resultEvent()),
    );
    const run = await runClaudeCliAgent({ ...base, spawn });
    expect(calls[0]).toMatchObject({ cwd: "/repo", stdin: "the prompt", timeoutMs: 1000 });
    expect(calls[0]?.args).toContain("--max-turns");
    expect(run.structuredOutput).toEqual({ ok: true });
    expect(run.info).toEqual({
      model: "m",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
      latencyMs: 1234,
      nominalCostUsd: 0.42,
      turns: 4,
      toolCalls: [{ tool: "Read", target: "a.ts", denied: false }],
    });
  });

  it("throws a timeout error when the process was killed", async () => {
    const { spawn } = spawnReturning("", { timedOut: true, exitCode: 137 });
    await expect(runClaudeCliAgent({ ...base, spawn })).rejects.toBeInstanceOf(
      ClaudeCliTimeoutError,
    );
  });

  it("says plainly that the agent ran out of turns", async () => {
    const { spawn } = spawnReturning(
      stream(resultEvent({ subtype: "error_max_turns", is_error: true, structured_output: null })),
      { exitCode: 1 },
    );
    await expect(runClaudeCliAgent({ ...base, spawn })).rejects.toThrow(
      /stopped before answering \(error_max_turns, 4 turns\)/,
    );
  });

  it("fails on a stream without a result event", async () => {
    const { spawn } = spawnReturning(stream(toolUse("t1", "Read", { file_path: "a.ts" })), {
      exitCode: 1,
    });
    await expect(runClaudeCliAgent({ ...base, spawn })).rejects.toBeInstanceOf(Error);
  });

  it("fails on output that does not match the schema", async () => {
    const { spawn } = spawnReturning(stream(resultEvent({ structured_output: { ok: "yes" } })));
    await expect(runClaudeCliAgent({ ...base, spawn })).rejects.toBeInstanceOf(ClaudeCliError);
  });
});
