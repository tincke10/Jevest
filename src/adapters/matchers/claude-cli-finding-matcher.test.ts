import { describe, expect, it, vi } from "vitest";
import type { FindingMatchInput } from "../../domain/ports/finding-matcher-port.js";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import { ClaudeCliError } from "../reviewers/reviewer-errors.js";
import {
  CLAUDE_CLI_MATCHER_DEFAULT_MODEL,
  MATCHER_SYSTEM_PROMPT,
  buildMatcherUserPrompt,
  createClaudeCliFindingMatcher,
} from "./claude-cli-finding-matcher.js";

const INPUT: FindingMatchInput = {
  goldenIssues: [
    {
      id: "I1",
      file: "src/cart.ts",
      line: 10,
      title: "Total ignores discount",
      notes: "cart.ts:10",
    },
    { id: "I2", file: null, line: null, title: "Currency hardcoded" },
  ],
  candidate: { file: "src/cart.ts", line: 12, text: "The discount is never applied to the total." },
};

function envelope(structured: unknown) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: structured,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.004,
    duration_ms: 900,
  });
}

function spawnReturning(structured: unknown): ClaudeCliSpawn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    stdout: envelope(structured),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  })) as unknown as ClaudeCliSpawn & ReturnType<typeof vi.fn>;
}

describe("createClaudeCliFindingMatcher", () => {
  it("defaults to a small model and runs claude in safe mode with a JSON schema", async () => {
    const spawn = spawnReturning({ match: "I1", reason: "same defect" });
    const matcher = createClaudeCliFindingMatcher({ spawn });
    const result = await matcher.match(INPUT);
    expect(result).toEqual({ issueId: "I1", costUsd: 0.004 });
    const args = spawn.mock.calls[0]?.[0] as string[];
    expect(CLAUDE_CLI_MATCHER_DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(MATCHER_SYSTEM_PROMPT);
    expect(args).toContain("--json-schema");
    expect(args[args.length - 1]).toBe(buildMatcherUserPrompt(INPUT));
  });

  it("maps none to null and honors a configured model", async () => {
    const spawn = spawnReturning({ match: "none", reason: "different topic" });
    const matcher = createClaudeCliFindingMatcher({ spawn, model: "claude-haiku-5" });
    expect((await matcher.match(INPUT)).issueId).toBeNull();
    const args = spawn.mock.calls[0]?.[0] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5");
  });

  it("rejects an answer that names an issue it was not offered", async () => {
    const matcher = createClaudeCliFindingMatcher({
      spawn: spawnReturning({ match: "I7", reason: "?" }),
    });
    await expect(matcher.match(INPUT)).rejects.toThrow(/I7/);
  });

  it("surfaces a malformed envelope as a ClaudeCliError", async () => {
    const matcher = createClaudeCliFindingMatcher({ spawn: spawnReturning({ nope: true }) });
    await expect(matcher.match(INPUT)).rejects.toBeInstanceOf(ClaudeCliError);
  });
});

describe("buildMatcherUserPrompt", () => {
  it("lists every issue with its location and the candidate", () => {
    const prompt = buildMatcherUserPrompt(INPUT);
    expect(prompt).toContain("I1 — src/cart.ts:10 — Total ignores discount");
    expect(prompt).toContain("I2 — (no location) — Currency hardcoded");
    expect(prompt).toContain("Evidence: cart.ts:10");
    expect(prompt).toContain("src/cart.ts:12");
    expect(prompt).toContain("The discount is never applied to the total.");
  });
});
