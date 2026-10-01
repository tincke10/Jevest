import { describe, expect, it } from "vitest";
import type { AgentSpawn } from "../claude-cli/claude-cli-agent.js";
import {
  AGENTIC_REVIEW_JSON_SCHEMA,
  FINDING_VERIFICATION_JSON_SCHEMA,
} from "./agentic-output-schema.js";
import { AGENTIC_REVIEW_SYSTEM_PROMPT, FINDING_VERIFIER_SYSTEM_PROMPT } from "./agentic-prompt.js";
import { createClaudeCliAgenticReviewer } from "./claude-cli-agentic-reviewer.js";
import { createClaudeCliFindingVerifier } from "./claude-cli-finding-verifier.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function resultLine(structured: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 9,
    duration_ms: 5000,
    total_cost_usd: 0.8,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
    structured_output: structured,
  });
}

function recordingSpawn(stdout: string) {
  const calls: { args: readonly string[]; cwd: string; stdin: string; timeoutMs: number }[] = [];
  const spawn: AgentSpawn = async (args, options) => {
    calls.push({ args, ...options });
    return { stdout, stderr: "", exitCode: 0, timedOut: false };
  };
  return { spawn, calls };
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

describe("createClaudeCliAgenticReviewer", () => {
  it("runs one agent in the checkout with the static system prompt, the schema and the configured caps", async () => {
    const { spawn, calls } = recordingSpawn(`${resultLine({ findings: [] })}\n`);
    const reviewer = createClaudeCliAgenticReviewer({
      spawn,
      model: "claude-opus-5",
      maxTurns: 40,
      timeoutMs: 900_000,
      now: () => 0,
    });
    const output = await reviewer.reviewPullRequest({
      prId: "acme/w#1",
      repoRoot: "/checkout",
      title: "T",
      changedFiles: ["a.ts"],
      diff: "+x",
    });
    const call = calls[0];
    expect(call?.cwd).toBe("/checkout");
    expect(call?.timeoutMs).toBe(900_000);
    expect(call?.stdin).toContain("+x");
    expect(argAfter(call?.args ?? [], "--system-prompt")).toBe(AGENTIC_REVIEW_SYSTEM_PROMPT);
    expect(argAfter(call?.args ?? [], "--json-schema")).toBe(
      JSON.stringify(AGENTIC_REVIEW_JSON_SCHEMA),
    );
    expect(argAfter(call?.args ?? [], "--max-turns")).toBe("40");
    expect(argAfter(call?.args ?? [], "--model")).toBe("claude-opus-5");
    expect(argAfter(call?.args ?? [], "--effort")).toBe("xhigh");
    expect(output).toMatchObject({
      findings: [],
      turns: 9,
      nominalCostUsd: 0.8,
      model: "claude-opus-5",
    });
  });

  it("passes the configured effort to the agent", async () => {
    const { spawn, calls } = recordingSpawn(`${resultLine({ findings: [] })}\n`);
    const reviewer = createClaudeCliAgenticReviewer({ spawn, effort: "max", now: () => 0 });
    await reviewer.reviewPullRequest({
      prId: "p",
      repoRoot: "/c",
      title: "T",
      changedFiles: ["a.ts"],
      diff: "",
    });
    expect(argAfter(calls[0]?.args ?? [], "--effort")).toBe("max");
  });

  it("returns redacted findings", async () => {
    const { spawn } = recordingSpawn(
      resultLine({
        findings: [
          {
            file: "a.ts",
            line: 1,
            category: "security",
            severity: "high",
            claim: `Logs ${SECRET}`,
            failingScenario: "any call",
            evidence: [{ file: "a.ts", line: 1, quote: `log("${SECRET}")` }],
            confidence: 0.9,
          },
        ],
      }),
    );
    const reviewer = createClaudeCliAgenticReviewer({ spawn, now: () => 0 });
    const output = await reviewer.reviewPullRequest({
      prId: "p",
      repoRoot: "/c",
      title: "T",
      changedFiles: ["a.ts"],
      diff: "",
    });
    expect(JSON.stringify(output.findings)).not.toContain(SECRET);
  });
});

describe("createClaudeCliFindingVerifier", () => {
  it("runs a fresh agent per finding with the verifier prompt, model and small turn cap", async () => {
    const { spawn, calls } = recordingSpawn(
      resultLine({ decision: "refuted", reason: `guarded at b.ts:3 ${SECRET}`, evidence: [] }),
    );
    const verifier = createClaudeCliFindingVerifier({
      spawn,
      model: "claude-sonnet-5",
      maxTurns: 12,
      now: () => 0,
    });
    const output = await verifier.verify({
      itemId: "p:f0",
      repoRoot: "/checkout",
      changedFiles: ["a.ts"],
      finding: {
        file: "a.ts",
        line: 1,
        category: "correctness",
        severity: "medium",
        claim: "c",
        failingScenario: "s",
        evidence: [],
        confidence: 0.5,
      },
    });
    const args = calls[0]?.args ?? [];
    expect(calls[0]?.cwd).toBe("/checkout");
    expect(argAfter(args, "--system-prompt")).toBe(FINDING_VERIFIER_SYSTEM_PROMPT);
    expect(argAfter(args, "--json-schema")).toBe(JSON.stringify(FINDING_VERIFICATION_JSON_SCHEMA));
    expect(argAfter(args, "--max-turns")).toBe("12");
    expect(argAfter(args, "--model")).toBe("claude-sonnet-5");
    expect(argAfter(args, "--effort")).toBe("medium");
    expect(output.decision).toBe("refuted");
    expect(output.reason).not.toContain(SECRET);
  });
});
