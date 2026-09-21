import { describe, expect, it, vi } from "vitest";
import type { ChangeSummaryInput } from "../../domain/ports/change-summarizer-port.js";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { createClaudeCliSummarizer } from "./claude-cli-summarizer.js";
import { SUMMARY_SYSTEM_PROMPT } from "./summary-prompt.js";

const SAMPLE_INPUT: ChangeSummaryInput = {
  prId: "acme/shop#42",
  files: [
    {
      path: "src/checkout/total.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      patch: "@@ -1,3 +1,6 @@\n-const tax = 0;\n+const tax = subtotal * rate;",
    },
  ],
};

const STRUCTURED = {
  what_changes: "Applies the tax rate to the checkout subtotal.",
  behavior_changes: ["Checkout totals now include tax."],
  user_facing: true,
  breaking: false,
  areas: ["checkout"],
  risks: [],
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    result: JSON.stringify(STRUCTURED),
    structured_output: STRUCTURED,
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

describe("createClaudeCliSummarizer", () => {
  it("maps a successful envelope to ChangeSummaryOutput, including nominalCostUsd and sessionId", async () => {
    const spawn = okSpawn();
    const summarizer = createClaudeCliSummarizer({ spawn });

    const output = await summarizer.summarize(SAMPLE_INPUT);

    expect(output.summary).toEqual({
      whatChanges: STRUCTURED.what_changes,
      behaviorChanges: STRUCTURED.behavior_changes,
      userFacing: true,
      breaking: false,
      areas: ["checkout"],
      risks: [],
    });
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

  it("builds the same minimal-footprint argv as the reviewer: --safe-mode, --tools '', the summary system prompt, and the json schema", async () => {
    const spawn = okSpawn();
    const summarizer = createClaudeCliSummarizer({ spawn });

    await summarizer.summarize(SAMPLE_INPUT);

    const [args] = spawn.mock.calls[0]!;
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-5");
    expect(args).toContain("--safe-mode");
    const toolsIndex = args.indexOf("--tools");
    expect(args[toolsIndex + 1]).toBe("");
    const systemIndex = args.indexOf("--system-prompt");
    expect(args[systemIndex + 1]).toBe(SUMMARY_SYSTEM_PROMPT);
    const schemaIndex = args.indexOf("--json-schema");
    expect(JSON.parse(args[schemaIndex + 1] as string)).toHaveProperty("properties.what_changes");
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain("src/checkout/total.ts");
    expect(promptArg).toContain("const tax = subtotal * rate;");
  });

  it("never passes the pull request id to the CLI (no author narrative may leak)", async () => {
    const spawn = okSpawn();
    await createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT);
    const [args] = spawn.mock.calls[0]!;
    expect(args.join("\n")).not.toContain(SAMPLE_INPUT.prId);
  });

  it("allows overriding the model", async () => {
    const spawn = okSpawn();
    await createClaudeCliSummarizer({ spawn, model: "claude-sonnet-5" }).summarize(SAMPLE_INPUT);
    const [args] = spawn.mock.calls[0]!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  it("passes the configured timeout through to spawn (default 180000ms)", async () => {
    const spawn = okSpawn();
    await createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT);
    const [, options] = spawn.mock.calls[0]!;
    expect(options.timeoutMs).toBe(180_000);
  });

  it("honors a custom timeoutMs option", async () => {
    const spawn = okSpawn();
    await createClaudeCliSummarizer({ spawn, timeoutMs: 5_000 }).summarize(SAMPLE_INPUT);
    const [, options] = spawn.mock.calls[0]!;
    expect(options.timeoutMs).toBe(5_000);
  });

  it("falls back to a measured latency when duration_ms is absent", async () => {
    const spawn = okSpawn({ duration_ms: undefined });
    let tick = 1_000;
    const now = () => {
      tick += 250;
      return tick;
    };
    const output = await createClaudeCliSummarizer({ spawn, now }).summarize(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(250);
  });

  it("throws ClaudeCliTimeoutError when the process times out", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    await expect(
      createClaudeCliSummarizer({ spawn, timeoutMs: 1000 }).summarize(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliTimeoutError);
  });

  it("throws ClaudeCliProcessError on a non-zero exit code", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
      timedOut: false,
    }));
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliProcessError,
    );
  });

  it("throws ClaudeCliError on invalid JSON stdout", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ClaudeCliError when is_error is true and not a rate-limit signal", async () => {
    const spawn = okSpawn({ is_error: true, subtype: "error_during_execution", result: "boom" });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ClaudeCliError when subtype is not success", async () => {
    const spawn = okSpawn({ subtype: "error_max_turns" });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ClaudeCliError when structured_output is missing", async () => {
    const spawn = okSpawn({ structured_output: null });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ClaudeCliError when structured_output fails schema validation", async () => {
    const spawn = okSpawn({ structured_output: { what_changes: 42 } });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ReviewerRateLimitError when api_error_status is 429", async () => {
    const spawn = okSpawn({ is_error: true, api_error_status: 429, result: "rate limited" });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  it("throws ReviewerRateLimitError when the error text mentions a usage limit", async () => {
    const spawn = okSpawn({
      is_error: true,
      api_error_status: null,
      subtype: "error_during_execution",
      result: "Claude usage limit reached for this session",
    });
    await expect(createClaudeCliSummarizer({ spawn }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  describe.skipIf(!process.env.CLAUDE_CLI_LIVE_TEST)("live", () => {
    it("summarizes a real change by shelling out to claude -p", async () => {
      const output = await createClaudeCliSummarizer({}).summarize(SAMPLE_INPUT);
      expect(output.summary.whatChanges.length).toBeGreaterThan(0);
      expect(output.usage.inputTokens + output.usage.cacheCreationInputTokens).toBeGreaterThan(0);
    });
  });
});
