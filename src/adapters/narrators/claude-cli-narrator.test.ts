import { describe, expect, it, vi } from "vitest";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { createClaudeCliNarrator } from "./claude-cli-narrator.js";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative-prompt.js";
import {
  SAMPLE_NARRATIVE_INPUT as SAMPLE_INPUT,
  SAMPLE_REVIEW_MARKDOWN,
} from "./narrative-test-fixtures.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    structured_output: { review: SAMPLE_REVIEW_MARKDOWN },
    usage: {
      input_tokens: 3,
      output_tokens: 180,
      cache_creation_input_tokens: 1500,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0.021,
    duration_ms: 4200,
    session_id: "session-1",
    ...overrides,
  };
}

function fakeSpawn(
  impl: () => Promise<{
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

describe("createClaudeCliNarrator", () => {
  it("maps a successful envelope to ReviewNarrativeOutput, including nominalCostUsd and sessionId", async () => {
    const output = await createClaudeCliNarrator({ spawn: okSpawn() }).narrate(SAMPLE_INPUT);

    expect(output.markdown).toBe(SAMPLE_REVIEW_MARKDOWN);
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 3,
      outputTokens: 180,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1500,
    });
    expect(output.latencyMs).toBe(4200);
    expect(output.nominalCostUsd).toBe(0.021);
    expect(output.sessionId).toBe("session-1");
  });

  it("runs the same minimal-footprint argv as the reviewer, with the narrative prompt and the tiny {review} schema", async () => {
    const spawn = okSpawn();
    await createClaudeCliNarrator({ spawn, model: "claude-sonnet-5" }).narrate(SAMPLE_INPUT);

    const [args, options] = spawn.mock.calls[0]!;
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(NARRATIVE_SYSTEM_PROMPT);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] as string)).toHaveProperty(
      "properties.review",
    );
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain("Write the review in: es");
    expect(promptArg).toContain("Rounding the tax to whole units drops cents");
    expect(promptArg).not.toContain(SAMPLE_INPUT.prId);
    expect(options.timeoutMs).toBe(180_000);
  });

  it("throws ClaudeCliTimeoutError when the process times out", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    await expect(createClaudeCliNarrator({ spawn }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliTimeoutError,
    );
  });

  it("throws ClaudeCliProcessError on a non-zero exit code", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
      timedOut: false,
    }));
    await expect(createClaudeCliNarrator({ spawn }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliProcessError,
    );
  });

  it("throws ClaudeCliError when the review is empty (schema miss)", async () => {
    const spawn = okSpawn({ structured_output: { review: "" } });
    await expect(createClaudeCliNarrator({ spawn }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ClaudeCliError,
    );
  });

  it("throws ReviewerRateLimitError on a usage-limit signal", async () => {
    const spawn = okSpawn({ is_error: true, api_error_status: 429, result: "rate limited" });
    await expect(createClaudeCliNarrator({ spawn }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });
});
