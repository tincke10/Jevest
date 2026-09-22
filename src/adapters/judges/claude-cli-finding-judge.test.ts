import { describe, expect, it, vi } from "vitest";
import type { FindingJudgeInput } from "../../domain/ports/finding-judge-port.js";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { createClaudeCliFindingJudge } from "./claude-cli-finding-judge.js";
import { JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";

const SAMPLE_INPUT: FindingJudgeInput = {
  findingId: "zod-9446b5c-1::claude-cli::0",
  hunkDiff:
    "@@ -1268,3 +1268,3 @@\n-const outputVar = newVar(ctx);\n+const outputVar = newVar(ctx2);",
  file: "packages/zod/src/v4/core/compile.ts",
  lineStart: 1268,
  lineEnd: 1268,
  claim: "The wrong context is passed to newVar.",
  rationale: "ctx is the outer context; the inner one is ctx2.",
};

const STRUCTURED = {
  is_real_defect_probability: 0.85,
  severity: "major",
  is_style_only: false,
  actionable: true,
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
      output_tokens: 40,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0.011,
    duration_ms: 1500,
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

describe("createClaudeCliFindingJudge", () => {
  it("maps a successful envelope to FindingJudgeOutput, including nominalCostUsd and sessionId", async () => {
    const spawn = okSpawn();
    const output = await createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT);

    expect(output.judgment).toEqual({
      isRealDefectProb: 0.85,
      severity: "major",
      isStyleOnly: false,
      actionable: true,
    });
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 2,
      outputTokens: 40,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 900,
    });
    expect(output.latencyMs).toBe(1500);
    expect(output.nominalCostUsd).toBe(0.011);
    expect(output.sessionId).toBe("4051c0e2-d18d-44c7-9ad8-794cf78ee23b");
  });

  it("builds the shared minimal-footprint argv with the judge prompt and schema, and shows the model only what Jev sees", async () => {
    const spawn = okSpawn();
    await createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT);

    const [args] = spawn.mock.calls[0]!;
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(JUDGE_SYSTEM_PROMPT);
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1] as string);
    expect(schema).toHaveProperty("properties.is_real_defect_probability");
    expect(schema).toHaveProperty("properties.severity");
    expect(schema).toHaveProperty("properties.is_style_only");
    expect(schema).toHaveProperty("properties.actionable");
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain(SAMPLE_INPUT.hunkDiff);
    expect(promptArg).toContain(SAMPLE_INPUT.claim);
    expect(promptArg).toContain(SAMPLE_INPUT.rationale);
    expect(promptArg).toContain(SAMPLE_INPUT.file);
    expect(promptArg).toContain("1268");
    expect(args.join("\n")).not.toContain(SAMPLE_INPUT.findingId);
  });

  it("allows overriding the model and timeout", async () => {
    const spawn = okSpawn();
    await createClaudeCliFindingJudge({ spawn, model: "claude-sonnet-5", timeoutMs: 5_000 }).judge(
      SAMPLE_INPUT,
    );
    const [args, options] = spawn.mock.calls[0]!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(options.timeoutMs).toBe(5_000);
  });

  it("rejects a probability outside 0..1 as a schema failure", async () => {
    const spawn = okSpawn({
      structured_output: { ...STRUCTURED, is_real_defect_probability: 1.5 },
    });
    await expect(createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("rejects an unknown severity as a schema failure", async () => {
    const spawn = okSpawn({ structured_output: { ...STRUCTURED, severity: "blocker" } });
    await expect(createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ClaudeCliTimeoutError when the process times out", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    await expect(
      createClaudeCliFindingJudge({ spawn, timeoutMs: 1000 }).judge(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliTimeoutError);
  });

  it("throws ClaudeCliProcessError on a non-zero exit code", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
      timedOut: false,
    }));
    await expect(createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliProcessError,
    );
  });

  it("throws ReviewerRateLimitError on a usage-limit signal", async () => {
    const spawn = okSpawn({
      is_error: true,
      api_error_status: null,
      subtype: "error_during_execution",
      result: "Claude usage limit reached",
    });
    await expect(createClaudeCliFindingJudge({ spawn }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });
});
