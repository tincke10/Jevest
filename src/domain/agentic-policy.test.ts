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
  describe("Jev never discards (measured: every finding its judge dropped was valid)", () => {
    it("makes noMatch a question right after the supports step", () => {
      const result = routeAgenticFinding(
        input({ supports: { choice: "noMatch", confidence: 0.9 }, mechanism: undefined }),
      );
      expect(result).toMatchObject({ route: "question", code: "supports-noMatch" });
      expect(result !== "next" && result.reason).toMatch(/noMatch/);
    });

    it("makes a support confidence under the minimum a question, whatever the pick", () => {
      const result = routeAgenticFinding(
        input({
          supports: { choice: "proves", confidence: AGENTIC_SUPPORTS_MIN_CONFIDENCE - 0.01 },
          mechanism: undefined,
        }),
      );
      expect(result).toMatchObject({ route: "question", code: "supports-low-confidence" });
    });

    it("makes mechanism noIssue a question", () => {
      const result = routeAgenticFinding(
        input({ mechanism: { choice: "noIssue", confidence: 0.6 }, severity: undefined }),
      );
      expect(result).toMatchObject({ route: "question", code: "mechanism-noIssue" });
      expect(result !== "next" && result.reason).toMatch(/noIssue/);
    });

    it("makes Jev severity below 1 a question", () => {
      expect(
        routeAgenticFinding(input({ severity: { score: 0.4, confidence: 0.8 } })),
      ).toMatchObject({ route: "question", code: "severity-low" });
    });

    it("keeps a Jev doubt a question even when the verifier confirmed it", () => {
      expect(
        routeAgenticFinding(
          input({ supports: { choice: "noMatch", confidence: 0.9 }, verifier: "confirmed" }),
        ),
      ).toMatchObject({ route: "question" });
    });
  });

  it("asks for the next step while a stage is missing", () => {
    expect(routeAgenticFinding(input({ mechanism: undefined, severity: undefined }))).toBe("next");
    expect(routeAgenticFinding(input({ severity: undefined }))).toBe("next");
  });

  describe("with the verifier on, its confirmation decides publication", () => {
    it("publishes a verifier-confirmed finding the reviewer rated medium or above, even when Jev says partially", () => {
      for (const agentSeverity of ["medium", "high", "critical"] as const) {
        expect(
          routeAgenticFinding(
            input({
              supports: { choice: "partially", confidence: 0.6 },
              verifier: "confirmed",
              agentSeverity,
            }),
          ),
        ).toMatchObject({ route: "publish", code: "verifier-confirmed" });
      }
    });

    it("keeps a verifier-confirmed low-severity finding a question", () => {
      expect(
        routeAgenticFinding(input({ verifier: "confirmed", agentSeverity: "low" })),
      ).toMatchObject({ route: "question" });
    });

    it("caps a finding the verifier could not confirm at a question", () => {
      const result = routeAgenticFinding(input({ verifier: "uncertain" }));
      expect(result).toMatchObject({ route: "question" });
      expect(result !== "next" && result.reason).toMatch(/verifier/);
    });
  });

  describe("without a verifier, Jev's support bar decides publication", () => {
    it("publishes proves over the bar with severity >= 1", () => {
      expect(routeAgenticFinding(input())).toEqual({
        route: "publish",
        code: "supported",
        reason: expect.any(String),
      });
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
  });
});
