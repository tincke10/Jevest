import { describe, expect, it, vi } from "vitest";
import { matchCandidates } from "../../application/eval/match-candidates.js";
import type { FindingMatchInput } from "../../domain/ports/finding-matcher-port.js";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import { ClaudeCliError } from "../reviewers/reviewer-errors.js";
import {
  CLAUDE_CLI_MATCHER_DEFAULT_EFFORT,
  CLAUDE_CLI_MATCHER_DEFAULT_MODEL,
  MATCHER_NOTES_MAX,
  MATCHER_SAME_PROBLEM_RULE,
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
      locations: [{ file: "src/checkout.ts", line: 44 }],
      title: "Total ignores discount",
      category: "correctness",
      verdict: "real",
      notes: "cart.ts:10 sums line prices before applyDiscount runs",
    },
    { id: "I2", file: null, line: null, title: "Currency hardcoded" },
  ],
  candidate: {
    file: "src/cart.ts",
    line: 12,
    text: "The discount is never applied to the total. — Checkout with a coupon charges full price",
    claim: "The discount is never applied to the total.",
    failingScenario: "Checkout with a coupon charges full price",
    evidence: [{ file: "src/cart.ts", line: 12, quote: "return sum(lines)" }],
  },
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

type SpawnMock = ClaudeCliSpawn & ReturnType<typeof vi.fn>;

function spawnReturning(structured: unknown): SpawnMock {
  return vi.fn(async () => ({
    stdout: envelope(structured),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  })) as unknown as SpawnMock;
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

describe("createClaudeCliFindingMatcher", () => {
  it("defaults to opus at medium effort, in safe mode, without tools, with a JSON schema", async () => {
    const spawn = spawnReturning({ match: "I1", sameRootCause: true, reason: "same defect" });
    const matcher = createClaudeCliFindingMatcher({ spawn });
    const result = await matcher.match(INPUT);
    expect(result).toEqual({ issueId: "I1", costUsd: 0.004, reason: "same defect" });
    const args = spawn.mock.calls[0]?.[0] as string[];
    expect(CLAUDE_CLI_MATCHER_DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(CLAUDE_CLI_MATCHER_DEFAULT_EFFORT).toBe("medium");
    expect(args).toContain("--safe-mode");
    expect(argAfter(args, "--tools")).toBe("");
    expect(argAfter(args, "--model")).toBe("claude-opus-5-5");
    expect(argAfter(args, "--effort")).toBe("medium");
    expect(argAfter(args, "--system-prompt")).toBe(MATCHER_SYSTEM_PROMPT);
    expect(args[args.length - 1]).toBe(buildMatcherUserPrompt(INPUT));
  });

  it("asks for a decision-first JSON: match, then sameRootCause, then the reason", async () => {
    const spawn = spawnReturning({ match: "none", sameRootCause: false, reason: "x" });
    await createClaudeCliFindingMatcher({ spawn }).match(INPUT);
    const args = spawn.mock.calls[0]?.[0] as string[];
    const schema = JSON.parse(argAfter(args, "--json-schema") as string) as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["match", "sameRootCause", "reason"]);
    expect(schema.properties.sameRootCause?.type).toBe("boolean");
    expect(schema.required).toEqual(["match", "sameRootCause", "reason"]);
  });

  it("honors a configured model and effort, and maps none to null", async () => {
    const spawn = spawnReturning({ match: "none", sameRootCause: false, reason: "different" });
    const matcher = createClaudeCliFindingMatcher({
      spawn,
      model: "claude-haiku-5",
      effort: "low",
    });
    expect((await matcher.match(INPUT)).issueId).toBeNull();
    const args = spawn.mock.calls[0]?.[0] as string[];
    expect(argAfter(args, "--model")).toBe("claude-haiku-5");
    expect(argAfter(args, "--effort")).toBe("low");
  });

  it("treats a match the model itself says is not the same root cause as none", async () => {
    const matcher = createClaudeCliFindingMatcher({
      spawn: spawnReturning({ match: "I1", sameRootCause: false, reason: "only same file" }),
    });
    expect((await matcher.match(INPUT)).issueId).toBeNull();
  });

  it("rejects an answer that names an issue it was not offered", async () => {
    const matcher = createClaudeCliFindingMatcher({
      spawn: spawnReturning({ match: "I7", sameRootCause: true, reason: "?" }),
    });
    await expect(matcher.match(INPUT)).rejects.toThrow(/I7/);
  });

  it("surfaces a malformed envelope as a ClaudeCliError", async () => {
    const matcher = createClaudeCliFindingMatcher({ spawn: spawnReturning({ nope: true }) });
    await expect(matcher.match(INPUT)).rejects.toBeInstanceOf(ClaudeCliError);
  });
});

describe("MATCHER_SYSTEM_PROMPT", () => {
  it("states the same-problem rule and to prefer none when unsure", () => {
    expect(MATCHER_SYSTEM_PROMPT).toContain(MATCHER_SAME_PROBLEM_RULE);
    expect(MATCHER_SAME_PROBLEM_RULE).toMatch(/SAME underlying problem/);
    expect(MATCHER_SAME_PROBLEM_RULE).toMatch(/same root cause and same consequence/);
    expect(MATCHER_SAME_PROBLEM_RULE).toMatch(/not merely the same file or similar words/);
    expect(MATCHER_SAME_PROBLEM_RULE).toMatch(/prefer "none" when unsure/);
  });
});

describe("buildMatcherUserPrompt", () => {
  it("gives every issue its id, locations, verdict, category, title and notes", () => {
    const prompt = buildMatcherUserPrompt(INPUT);
    expect(prompt).toContain(
      "- I1 [real, correctness] src/cart.ts:10, src/checkout.ts:44 — Total ignores discount",
    );
    expect(prompt).toContain("  Notes: cart.ts:10 sums line prices before applyDiscount runs");
    expect(prompt).toContain("- I2 (no location) — Currency hardcoded");
  });

  it("gives the candidate's location, claim, failing scenario and evidence quotes", () => {
    const prompt = buildMatcherUserPrompt(INPUT);
    expect(prompt).toContain("Finding at src/cart.ts:12");
    expect(prompt).toContain("Claim: The discount is never applied to the total.");
    expect(prompt).toContain("Failing scenario: Checkout with a coupon charges full price");
    expect(prompt).toContain("- src/cart.ts:12: return sum(lines)");
  });

  it("falls back to the candidate text when there is no separate claim", () => {
    const prompt = buildMatcherUserPrompt({
      ...INPUT,
      candidate: { file: null, line: null, text: "A narrative point" },
    });
    expect(prompt).toContain("Finding at (no location)");
    expect(prompt).toContain("Claim: A narrative point");
    expect(prompt).not.toContain("Failing scenario:");
    expect(prompt).not.toContain("Evidence:");
  });

  it("truncates long notes", () => {
    const long = "n".repeat(2000);
    const prompt = buildMatcherUserPrompt({
      ...INPUT,
      goldenIssues: [{ id: "I1", file: "a.ts", line: 1, title: "t", notes: long }],
    });
    const notesLine = prompt.split("\n").find((l) => l.startsWith("  Notes: ")) as string;
    expect(notesLine.length).toBeLessThanOrEqual("  Notes: ".length + MATCHER_NOTES_MAX);
    expect(notesLine.endsWith("…")).toBe(true);
  });
});

describe("regression: same file, similar words, different root cause", () => {
  // Synthetic: two issues in one file whose titles share words with the
  // finding; only the notes tell the root causes apart. The adjudicated
  // failure was the matcher picking the word-sharing issue.
  const issues = [
    {
      id: "MARKERS",
      file: "src/sync/command.ts",
      line: 40,
      title: "sync command rewrites config markers",
      severity: "high" as const,
      verdict: "real" as const,
      category: "correctness",
      notes:
        "Each run re-inserts the BEGIN/END marker block instead of replacing it: a second run duplicates it.",
    },
    {
      id: "TIMEOUT",
      file: "src/sync/command.ts",
      line: 210,
      title: "sync command config timeout ignored",
      severity: "medium" as const,
      verdict: "real" as const,
      category: "correctness",
      notes: "The --timeout flag is parsed but never passed to the HTTP client.",
    },
  ];
  const candidate = {
    id: "c:finding:0",
    file: "src/sync/command.ts",
    line: 205,
    text: "sync command ignores the config file's retry count",
    claim: "sync command ignores the config file's retry count",
    failingScenario: "retries: 5 in the config still retries 3 times",
    bucket: "shown" as const,
    source: "finding" as const,
  };

  it("offers both same-file issues with their notes, the rule and the decision-first schema, and honors none", async () => {
    const spawn = vi.fn(async (args: readonly string[]) => {
      const user = args[args.length - 1] as string;
      expect(user).toContain(issues[0]?.notes);
      expect(user).toContain(issues[1]?.notes);
      expect(argAfter(args, "--system-prompt")).toContain(MATCHER_SAME_PROBLEM_RULE);
      const schema = JSON.parse(argAfter(args, "--json-schema") as string);
      expect(Object.keys(schema.properties)[0]).toBe("match");
      // A faithful model following the rule: different root cause → none.
      return {
        stdout: envelope({
          match: "none",
          sameRootCause: false,
          reason: "retry count, not the timeout flag nor the markers",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    }) as unknown as SpawnMock;
    const result = await matchCandidates({
      issues,
      candidates: [candidate],
      matcher: createClaudeCliFindingMatcher({ spawn }),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.matched[0]?.issueId).toBeNull();
  });

  it("drops a word-overlap pick the model flags as a different root cause", async () => {
    const result = await matchCandidates({
      issues,
      candidates: [candidate],
      matcher: createClaudeCliFindingMatcher({
        spawn: spawnReturning({
          match: "TIMEOUT",
          sameRootCause: false,
          reason: "same file and words, different cause",
        }),
      }),
    });
    expect(result.matched[0]?.issueId).toBeNull();
  });
});
