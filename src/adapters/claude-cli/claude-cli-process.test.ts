import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { buildClaudeCliArgs, parseClaudeCliEnvelope } from "./claude-cli-process.js";

const schema = z.object({ answer: z.string() });

function ok(structured: unknown, overrides: Record<string, unknown> = {}) {
  return {
    stdout: JSON.stringify({
      subtype: "success",
      is_error: false,
      api_error_status: null,
      structured_output: structured,
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0.5,
      duration_ms: 7,
      session_id: "s-1",
      ...overrides,
    }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

describe("buildClaudeCliArgs", () => {
  it("emits the minimal-footprint flags in order with the user prompt last", () => {
    const args = buildClaudeCliArgs({
      model: "m",
      systemPrompt: "sys",
      jsonSchema: { type: "object" },
      userPrompt: "user",
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "m",
      "--safe-mode",
      "--tools",
      "",
      "--system-prompt",
      "sys",
      "--json-schema",
      '{"type":"object"}',
      "user",
    ]);
  });
});

describe("parseClaudeCliEnvelope", () => {
  const context = { provider: "claude-cli", itemId: "x", timeoutMs: 10, fallbackLatencyMs: 3 };

  it("returns the validated structured output plus usage, latency, cost and session id", () => {
    const parsed = parseClaudeCliEnvelope(ok({ answer: "a" }), schema, context);
    expect(parsed.structuredOutput).toEqual({ answer: "a" });
    expect(parsed.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(parsed.latencyMs).toBe(7);
    expect(parsed.nominalCostUsd).toBe(0.5);
    expect(parsed.sessionId).toBe("s-1");
  });

  it("uses the fallback latency when duration_ms is absent and omits sessionId when absent", () => {
    const parsed = parseClaudeCliEnvelope(
      ok({ answer: "a" }, { duration_ms: undefined, session_id: undefined }),
      schema,
      context,
    );
    expect(parsed.latencyMs).toBe(3);
    expect(parsed.sessionId).toBeUndefined();
  });

  it("wraps a schema failure in ClaudeCliError with the api status and subtype", () => {
    expect(() => parseClaudeCliEnvelope(ok({ answer: 1 }), schema, context)).toThrow(
      ClaudeCliError,
    );
  });
});

describe("parseClaudeCliEnvelope on a non-zero exit", () => {
  const context = { provider: "claude-cli", itemId: "x", timeoutMs: 1000, fallbackLatencyMs: 5 };
  const padding = "p".repeat(600);

  it("classifies a usage-limit message in the envelope's result as ReviewerRateLimitError even when the process exited 1", () => {
    const stdout = JSON.stringify({
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: null,
      usage: { input_tokens: 0, output_tokens: 0, padding },
      result: "Claude usage limit reached. Your limit will reset at 3am",
    });
    expect(() =>
      parseClaudeCliEnvelope({ stdout, stderr: "", exitCode: 1, timedOut: false }, schema, context),
    ).toThrow(ReviewerRateLimitError);
  });

  it("surfaces the envelope's result text in ClaudeCliProcessError even when it sits past the 500-char excerpt", () => {
    const stdout = JSON.stringify({
      subtype: "error_during_execution",
      is_error: true,
      usage: { input_tokens: 0, output_tokens: 0, padding },
      result: "Something specific went wrong",
    });
    expect(() =>
      parseClaudeCliEnvelope({ stdout, stderr: "", exitCode: 1, timedOut: false }, schema, context),
    ).toThrow(/Something specific went wrong/);
  });

  it("still throws ClaudeCliProcessError with the raw excerpt when stdout is not JSON", () => {
    expect(() =>
      parseClaudeCliEnvelope(
        { stdout: "not json", stderr: "boom", exitCode: 127, timedOut: false },
        schema,
        context,
      ),
    ).toThrow(ClaudeCliProcessError);
  });
});
