import { describe, expect, it, vi } from "vitest";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { createClaudeCliDescriptionContextExtractor } from "./claude-cli-description-context-extractor.js";
import { DESCRIPTION_CONTEXT_SYSTEM_PROMPT } from "./description-context-prompt.js";
import {
  SAMPLE_EXTRACTION,
  SAMPLE_DESCRIPTION_CONTEXT_INPUT as SAMPLE_INPUT,
} from "./description-context-test-fixtures.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    structured_output: SAMPLE_EXTRACTION,
    usage: {
      input_tokens: 3,
      output_tokens: 90,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0.011,
    duration_ms: 2100,
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

describe("createClaudeCliDescriptionContextExtractor", () => {
  it("maps a successful envelope to DescriptionContextOutput, including nominalCostUsd and sessionId", async () => {
    const output = await createClaudeCliDescriptionContextExtractor({ spawn: okSpawn() }).extract(
      SAMPLE_INPUT,
    );
    expect(output.context.decisions).toEqual(SAMPLE_EXTRACTION.decisions);
    expect(output.discarded).toEqual(SAMPLE_EXTRACTION.discarded);
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 3,
      outputTokens: 90,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1200,
    });
    expect(output.latencyMs).toBe(2100);
    expect(output.nominalCostUsd).toBe(0.011);
    expect(output.sessionId).toBe("session-1");
  });

  it("runs the minimal-footprint argv with the extractor prompt and schema, without the PR id", async () => {
    const spawn = okSpawn();
    await createClaudeCliDescriptionContextExtractor({ spawn, model: "claude-sonnet-5" }).extract(
      SAMPLE_INPUT,
    );
    const [args, options] = spawn.mock.calls[0]!;
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(DESCRIPTION_CONTEXT_SYSTEM_PROMPT);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] as string)).toHaveProperty(
      "properties.discarded",
    );
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain("cache de 5 minutos");
    expect(promptArg).not.toContain(SAMPLE_INPUT.prId);
    expect(options.timeoutMs).toBe(180_000);
  });

  it("throws ClaudeCliTimeoutError, ClaudeCliProcessError, ClaudeCliError and ReviewerRateLimitError like the other CLI adapters", async () => {
    const run = (spawn: ClaudeCliSpawn) =>
      createClaudeCliDescriptionContextExtractor({ spawn }).extract(SAMPLE_INPUT);
    await expect(
      run(fakeSpawn(async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }))),
    ).rejects.toThrow(ClaudeCliTimeoutError);
    await expect(
      run(fakeSpawn(async () => ({ stdout: "", stderr: "nope", exitCode: 127, timedOut: false }))),
    ).rejects.toThrow(ClaudeCliProcessError);
    await expect(run(okSpawn({ structured_output: { decisions: [] } }))).rejects.toThrow(
      ClaudeCliError,
    );
    await expect(
      run(okSpawn({ is_error: true, api_error_status: 429, result: "rate limited" })),
    ).rejects.toThrow(ReviewerRateLimitError);
  });
});
