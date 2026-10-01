import { describe, expect, it } from "vitest";
import {
  AGENTIC_CATEGORIES,
  AGENTIC_SEVERITIES,
  type AgenticFinding,
  redactAgenticFinding,
} from "./agentic-finding.js";

function finding(overrides: Partial<AgenticFinding> = {}): AgenticFinding {
  return {
    file: "src/a.ts",
    line: 10,
    category: "correctness",
    severity: "high",
    claim: "The loop skips the last element.",
    failingScenario: "items=[1,2,3] -> only 1 and 2 are summed.",
    evidence: [{ file: "src/a.ts", line: 10, quote: "for (let i = 0; i < n - 1; i++)" }],
    confidence: 0.8,
    ...overrides,
  };
}

describe("agentic finding vocabulary", () => {
  it("allows exactly the five review categories and four severities", () => {
    expect(AGENTIC_CATEGORIES).toEqual([
      "correctness",
      "security",
      "regression",
      "reliability",
      "tests",
    ]);
    expect(AGENTIC_SEVERITIES).toEqual(["critical", "high", "medium", "low"]);
  });
});

describe("redactAgenticFinding", () => {
  it("redacts secrets in the claim, the failing scenario and every evidence quote (NFR-3)", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const redacted = redactAgenticFinding(
      finding({
        claim: `Token ${secret} is logged.`,
        failingScenario: `Any request prints ${secret}.`,
        evidence: [{ file: "src/a.ts", line: 3, quote: `const t = "${secret}";` }],
      }),
    );
    expect(redacted.claim).not.toContain(secret);
    expect(redacted.failingScenario).not.toContain(secret);
    expect(redacted.evidence[0]?.quote).not.toContain(secret);
    expect(redacted.claim).toContain("[REDACTED]");
  });

  it("leaves a finding without secrets unchanged", () => {
    const original = finding();
    expect(redactAgenticFinding(original)).toEqual(original);
  });
});
