import { describe, expect, it, vi } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import { type ClaudeCliSpawn, createClaudeCliReviewer } from "./claude-cli-reviewer.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "./reviewer-errors.js";

const SAMPLE_INPUT: ReviewInput = {
  hunkId: "zod-9446b5c-1",
  file: "packages/zod/src/v4/core/compile.ts",
  language: "typescript",
  hunkHeader: "@@ -1268,13 +1268,13 @@ function generateObjectCheck(",
  before: "const outputVar = newVar(ctx);",
  diff: "@@ -1268,13 +1268,13 @@\n-const outputVar = newVar(ctx);\n+const outputVar = newVar(ctx2);",
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    result: '{"findings":[]}',
    structured_output: { findings: [] },
    usage: {
      input_tokens: 2,
      output_tokens: 63,
      cache_creation_input_tokens: 1150,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0.013085,
    duration_ms: 1939,
    duration_api_ms: 1909,
    session_id: "4051c0e2-d18d-44c7-9ad8-794cf78ee23b",
    ...overrides,
  };
}

function fakeSpawn(
  impl: (args: readonly string[]) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }>,
): ClaudeCliSpawn & ReturnType<typeof vi.fn> {
  return vi.fn(impl) as unknown as ClaudeCliSpawn & ReturnType<typeof vi.fn>;
}

function okSpawn(overrides: Record<string, unknown> = {}) {
  return fakeSpawn(async () => ({
    stdout: JSON.stringify(envelope(overrides)),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
}

describe("createClaudeCliReviewer", () => {
  it("maps a successful envelope to ReviewOutput, including nominalCostUsd and sessionId", async () => {
    const spawn = okSpawn({
      structured_output: {
        findings: [
          {
            line_start: 1270,
            line_end: 1270,
            claim: "c",
            rationale: "r",
            suggested_severity: "major",
          },
        ],
      },
    });
    const reviewer = createClaudeCliReviewer({ spawn });

    const output = await reviewer.review(SAMPLE_INPUT);

    expect(output.findings).toEqual([
      { lineStart: 1270, lineEnd: 1270, claim: "c", rationale: "r", suggestedSeverity: "major" },
    ]);
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 2,
      outputTokens: 63,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1150,
    });
    expect(output.latencyMs).toBe(1939);
    expect(output.nominalCostUsd).toBe(0.013085);
    expect(output.sessionId).toBe("4051c0e2-d18d-44c7-9ad8-794cf78ee23b");
  });

  it("returns an empty findings array without forcing a finding", async () => {
    const spawn = okSpawn();
    const reviewer = createClaudeCliReviewer({ spawn });
    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.findings).toEqual([]);
  });

  it("builds the expected minimal-footprint argv: --safe-mode, --tools '', the shared system prompt, and the json schema", async () => {
    const spawn = okSpawn();
    const reviewer = createClaudeCliReviewer({ spawn });

    await reviewer.review(SAMPLE_INPUT);

    const [args] = spawn.mock.calls[0]!;
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-5");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--tools");
    const toolsIndex = args.indexOf("--tools");
    expect(args[toolsIndex + 1]).toBe("");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--json-schema");
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain(SAMPLE_INPUT.file);
    expect(promptArg).toContain(SAMPLE_INPUT.hunkHeader);
  });

  it("allows overriding the model", async () => {
    const spawn = okSpawn();
    const reviewer = createClaudeCliReviewer({ spawn, model: "claude-sonnet-5" });

    await reviewer.review(SAMPLE_INPUT);

    const [args] = spawn.mock.calls[0]!;
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("claude-sonnet-5");
  });

  it("passes the configured timeout through to spawn (default 180000ms)", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: JSON.stringify(envelope()),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const reviewer = createClaudeCliReviewer({ spawn });
    await reviewer.review(SAMPLE_INPUT);
    const [, options] = spawn.mock.calls[0]!;
    expect(options.timeoutMs).toBe(180_000);
  });

  it("honors a custom timeoutMs option", async () => {
    const spawn = okSpawn();
    const reviewer = createClaudeCliReviewer({ spawn, timeoutMs: 5_000 });
    await reviewer.review(SAMPLE_INPUT);
    const [, options] = spawn.mock.calls[0]!;
    expect(options.timeoutMs).toBe(5_000);
  });

  it("throws ClaudeCliTimeoutError when the process times out", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    const reviewer = createClaudeCliReviewer({ spawn, timeoutMs: 1000 });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliTimeoutError);
  });

  it("throws ClaudeCliProcessError on a non-zero exit code", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
      timedOut: false,
    }));
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliProcessError);
  });

  it("throws ClaudeCliError on invalid JSON stdout", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliError);
  });

  it("throws ClaudeCliError when is_error is true and not a rate-limit signal", async () => {
    const spawn = okSpawn({ is_error: true, subtype: "error_during_execution", result: "boom" });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliError);
  });

  it("throws ClaudeCliError when subtype is not success", async () => {
    const spawn = okSpawn({ subtype: "error_max_turns" });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliError);
  });

  it("throws ClaudeCliError when structured_output is missing", async () => {
    const spawn = okSpawn({ structured_output: null });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliError);
  });

  it("throws ClaudeCliError when structured_output fails schema validation", async () => {
    const spawn = okSpawn({ structured_output: { findings: [{ line_start: "not a number" }] } });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ClaudeCliError);
  });

  it("throws ReviewerRateLimitError when api_error_status is 429", async () => {
    const spawn = okSpawn({ is_error: true, api_error_status: 429, result: "rate limited" });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerRateLimitError);
  });

  it("throws ReviewerRateLimitError when the error text mentions a usage limit", async () => {
    const spawn = okSpawn({
      is_error: true,
      api_error_status: null,
      subtype: "error_during_execution",
      result: "Claude usage limit reached for this session",
    });
    const reviewer = createClaudeCliReviewer({ spawn });
    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerRateLimitError);
  });

  describe.skipIf(!process.env.CLAUDE_CLI_LIVE_TEST)("live", () => {
    it("reviews a real hunk by shelling out to claude -p", async () => {
      const reviewer = createClaudeCliReviewer({});
      const output = await reviewer.review(SAMPLE_INPUT);
      expect(Array.isArray(output.findings)).toBe(true);
      expect(output.usage.inputTokens + output.usage.cacheCreationInputTokens).toBeGreaterThan(0);
    });
  });
});
