import { describe, expect, it } from "vitest";
import {
  AGENTIC_MIN_SEVERITY,
  AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE,
  AGENTIC_SUPPORTS_MIN_CONFIDENCE,
  type AgenticRouteInput,
  routeAgenticFinding,
} from "./agentic-policy.js";

function input(overrides: Partial<AgenticRouteInput> = {}): AgenticRouteInput {
  return {
    supports: { choice: "proves", confidence: 0.9 },
    mechanism: { choice: "condition", confidence: 0.8 },
    severity: { score: 2, confidence: 0.7 },
    verifier: "none",
    agentSeverity: "high",
    ...overrides,
  };
}

describe("agentic policy constants", () => {
  it("orders the support bars and requires at least minor severity", () => {
    expect(AGENTIC_SUPPORTS_MIN_CONFIDENCE).toBeLessThan(AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE);
    expect(AGENTIC_MIN_SEVERITY).toBe(1);
  });
});

describe("routeAgenticFinding", () => {
  it("publishes proves with confidence over the bar and severity >= 1", () => {
    expect(routeAgenticFinding(input())).toEqual({
      route: "publish",
      code: "supported",
      reason: expect.any(String),
    });
  });

  it("discards on noMatch right after the supports step (no further question)", () => {
    const result = routeAgenticFinding(
      input({ supports: { choice: "noMatch", confidence: 0.9 }, mechanism: undefined }),
    );
    expect(result).toMatchObject({ route: "discard", code: "supports-noMatch" });
    expect(result !== "next" && result.reason).toMatch(/noMatch/);
  });

  it("discards when Jev's support confidence is under the minimum, whatever the pick", () => {
    const result = routeAgenticFinding(
      input({
        supports: { choice: "proves", confidence: AGENTIC_SUPPORTS_MIN_CONFIDENCE - 0.01 },
        mechanism: undefined,
      }),
    );
    expect(result).toMatchObject({ route: "discard" });
  });

  it("asks for the next step while a stage is missing", () => {
    expect(routeAgenticFinding(input({ mechanism: undefined, severity: undefined }))).toBe("next");
    expect(routeAgenticFinding(input({ severity: undefined }))).toBe("next");
  });

  it("discards on mechanism noIssue", () => {
    const result = routeAgenticFinding(
      input({ mechanism: { choice: "noIssue", confidence: 0.6 }, severity: undefined }),
    );
    expect(result).toMatchObject({ route: "discard", code: "mechanism-noIssue" });
    expect(result !== "next" && result.reason).toMatch(/noIssue/);
  });

  it("discards severity below 1 (no meaningful impact)", () => {
    expect(routeAgenticFinding(input({ severity: { score: 0.4, confidence: 0.8 } }))).toMatchObject(
      { route: "discard" },
    );
  });

  it("makes partially a question", () => {
    expect(
      routeAgenticFinding(input({ supports: { choice: "partially", confidence: 0.8 } })),
    ).toMatchObject({ route: "question" });
  });

  it("makes proves under the publish bar a question", () => {
    expect(
      routeAgenticFinding(
        input({
          supports: {
            choice: "proves",
            confidence: AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE - 0.01,
          },
        }),
      ),
    ).toMatchObject({ route: "question" });
  });

  it("caps a finding the verifier could not confirm at a question", () => {
    const result = routeAgenticFinding(input({ verifier: "uncertain" }));
    expect(result).toMatchObject({ route: "question" });
    expect(result !== "next" && result.reason).toMatch(/verifier/);
  });

  it("publishes a verifier-confirmed finding like an unverified one", () => {
    expect(routeAgenticFinding(input({ verifier: "confirmed" }))).toMatchObject({
      route: "publish",
    });
  });

  it("never discards on Jev's judgment a finding the reviewer rated critical: it becomes a question (FR-5.4)", () => {
    const result = routeAgenticFinding(
      input({
        supports: { choice: "noMatch", confidence: 0.9 },
        mechanism: undefined,
        agentSeverity: "critical",
      }),
    );
    expect(result).toMatchObject({ route: "question" });
    expect(result !== "next" && result.reason).toMatch(/critical/);
  });
});
