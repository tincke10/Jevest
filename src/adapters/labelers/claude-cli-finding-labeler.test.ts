import { describe, expect, it, vi } from "vitest";
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";
import type { ClaudeCliSpawn } from "../claude-cli/claude-cli-process.js";
import {
  ClaudeCliError,
  ClaudeCliProcessError,
  ClaudeCliTimeoutError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { createClaudeCliFindingLabeler } from "./claude-cli-finding-labeler.js";
import { CLAIM_VERIFICATION_SYSTEM_PROMPT, FIX_MATCH_SYSTEM_PROMPT } from "./labeler-prompt.js";

const SAMPLE_INPUT: FindingLabelerInput = {
  findingId: "zod-9446b5c-1-rev::claude-cli::0",
  claim: "mayOutputUndefined is the wrong predicate here.",
  rationale: "It keeps keys whose output is undefined, dropping defaulted ones.",
  file: "packages/zod/src/v4/core/compile.ts",
  lineStart: 1268,
  lineEnd: 1280,
  hunkHeader: "@@ -1268,13 +1268,13 @@ function generateObjectCheck(",
  language: "typescript",
  before: "const a = mayOutputUndefined(x);",
  after: "const a = mayOmitUndefined(x);",
  commitMessage: "fix: preserve undefined prefault outputs and object keys",
  hunkIsDefect: true,
  issueTitle: "Object keys dropped",
  issueBody: "Defaulted keys disappear from the output.",
};

function envelope(structured: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    result: JSON.stringify(structured),
    structured_output: structured,
    usage: {
      input_tokens: 3,
      output_tokens: 50,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0.021,
    duration_ms: 2100,
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

function okSpawn(structured: unknown, overrides: Record<string, unknown> = {}) {
  return fakeSpawn(async () => ({
    stdout: JSON.stringify(envelope(structured, overrides)),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
}

const FIX_MATCH_OUT = { verdict: "real", confidence: 0.9, reason: "the fix renamed the predicate" };
const CLAIM_OUT = { verdict: "present", confidence: 0.8, reason: "the before code calls it" };

describe("createClaudeCliFindingLabeler", () => {
  it("maps a fix-match envelope onto FixMatchOutput, with nominalCostUsd and sessionId", async () => {
    const spawn = okSpawn(FIX_MATCH_OUT);
    const output = await createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT);

    expect(output.framing).toBe("fix-match");
    expect(output.verdict).toBe("real");
    expect(output.confidence).toBe(0.9);
    expect(output.reason).toBe("the fix renamed the predicate");
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 3,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1200,
    });
    expect(output.latencyMs).toBe(2100);
    expect(output.nominalCostUsd).toBe(0.021);
    expect(output.sessionId).toBe("4051c0e2-d18d-44c7-9ad8-794cf78ee23b");
  });

  it("maps a claim-verification envelope onto ClaimVerificationOutput", async () => {
    const spawn = okSpawn(CLAIM_OUT);
    const output = await createClaudeCliFindingLabeler({ spawn }).labelClaimVerification(
      SAMPLE_INPUT,
    );
    expect(output.framing).toBe("claim-verification");
    expect(output.verdict).toBe("present");
  });

  it("sends each framing its own system prompt and its own verdict schema", async () => {
    const fixSpawn = okSpawn(FIX_MATCH_OUT);
    await createClaudeCliFindingLabeler({ spawn: fixSpawn }).labelFixMatch(SAMPLE_INPUT);
    const [fixArgs] = fixSpawn.mock.calls[0]!;
    expect(fixArgs[fixArgs.indexOf("--system-prompt") + 1]).toBe(FIX_MATCH_SYSTEM_PROMPT);
    const fixSchema = JSON.parse(fixArgs[fixArgs.indexOf("--json-schema") + 1] as string);
    expect(fixSchema.properties.verdict.enum).toEqual(["real", "not-this", "unclear"]);

    const claimSpawn = okSpawn(CLAIM_OUT);
    await createClaudeCliFindingLabeler({ spawn: claimSpawn }).labelClaimVerification(SAMPLE_INPUT);
    const [claimArgs] = claimSpawn.mock.calls[0]!;
    expect(claimArgs[claimArgs.indexOf("--system-prompt") + 1]).toBe(
      CLAIM_VERIFICATION_SYSTEM_PROMPT,
    );
    const claimSchema = JSON.parse(claimArgs[claimArgs.indexOf("--json-schema") + 1] as string);
    expect(claimSchema.properties.verdict.enum).toEqual(["present", "absent", "unclear"]);
  });

  it("uses the shared minimal-footprint argv and never leaks the finding id to the model", async () => {
    const spawn = okSpawn(FIX_MATCH_OUT);
    await createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT);
    const [args] = spawn.mock.calls[0]!;

    expect(args).toContain("--safe-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    const promptArg = args.at(-1) as string;
    expect(promptArg).toContain(SAMPLE_INPUT.before);
    expect(promptArg).toContain(SAMPLE_INPUT.after);
    expect(promptArg).toContain(SAMPLE_INPUT.commitMessage);
    expect(promptArg).toContain(SAMPLE_INPUT.claim);
    expect(args.join("\n")).not.toContain(SAMPLE_INPUT.findingId);
  });

  it("allows overriding the model and the timeout", async () => {
    const spawn = okSpawn(FIX_MATCH_OUT);
    await createClaudeCliFindingLabeler({
      spawn,
      model: "claude-sonnet-5",
      timeoutMs: 5_000,
    }).labelFixMatch(SAMPLE_INPUT);
    const [args, options] = spawn.mock.calls[0]!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(options.timeoutMs).toBe(5_000);
  });

  it("rejects a verdict from the OTHER framing rather than coercing it", async () => {
    const spawn = okSpawn({ verdict: "present", confidence: 0.5, reason: "r" });
    await expect(
      createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliError);
  });

  it("rejects a confidence outside 0..1 as a schema failure", async () => {
    const spawn = okSpawn({ ...FIX_MATCH_OUT, confidence: 1.4 });
    await expect(
      createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliError);
  });

  it("rejects a missing reason: an unauditable oracle label is worse than none", async () => {
    const spawn = okSpawn({ verdict: "real", confidence: 0.5 });
    await expect(
      createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliError);
  });

  it("throws ClaudeCliTimeoutError when the process times out", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    await expect(
      createClaudeCliFindingLabeler({ spawn, timeoutMs: 1000 }).labelFixMatch(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliTimeoutError);
  });

  it("throws ClaudeCliProcessError on a non-zero exit code", async () => {
    const spawn = fakeSpawn(async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
      timedOut: false,
    }));
    await expect(
      createClaudeCliFindingLabeler({ spawn }).labelFixMatch(SAMPLE_INPUT),
    ).rejects.toThrow(ClaudeCliProcessError);
  });

  it("throws ReviewerRateLimitError on a usage-limit signal, so the runner backs off", async () => {
    const spawn = okSpawn(FIX_MATCH_OUT, {
      is_error: true,
      api_error_status: null,
      subtype: "error_during_execution",
      result: "Claude usage limit reached",
    });
    await expect(
      createClaudeCliFindingLabeler({ spawn }).labelClaimVerification(SAMPLE_INPUT),
    ).rejects.toThrow(ReviewerRateLimitError);
  });

  it("falls back to wall-clock latency when the envelope carries no duration_ms", async () => {
    const spawn = okSpawn(FIX_MATCH_OUT, { duration_ms: undefined });
    let clock = 1000;
    const output = await createClaudeCliFindingLabeler({
      spawn,
      now: () => {
        clock += 250;
        return clock;
      },
    }).labelFixMatch(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(250);
  });
});
