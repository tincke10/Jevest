import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import type { ConfidencePolicyConfig } from "../../../domain/confidence-policy.js";
import type { Decision } from "../../../domain/decision.js";
import { runMergeGateStage } from "./merge-gate.js";

const policyConfig: ConfidencePolicyConfig = {
  merge_gate: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
  },
};

function script(prob: number): Record<string, Decision> {
  return { safe_to_automerge: { type: "noul", noul: prob } };
}

const baseInput = {
  policyConfig,
  riskLevel: "low" as const,
  triageCategory: "bugfix",
  publishedCountsBySeverity: { nit: 0, minor: 1, major: 0, critical: 0 },
  ciStatus: "success" as const,
  containsInjectedInstructionsHigh: false,
};

describe("runMergeGateStage", () => {
  it("emits a success conclusion when safe_to_automerge is in the auto band (FR-6.3)", async () => {
    const port = createFakeDecisionAdapter(script(0.95));
    const result = await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(result.conclusion).toBe("success");
    expect(result.safeToAutomergeProb).toBe(0.95);
  });

  it("emits a neutral conclusion when safe_to_automerge is in the confirm band", async () => {
    const port = createFakeDecisionAdapter(script(0.7));
    const result = await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(result.conclusion).toBe("neutral");
  });

  it("emits a failure conclusion when safe_to_automerge is in the escalate band", async () => {
    const port = createFakeDecisionAdapter(script(0.2));
    const result = await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(result.conclusion).toBe("failure");
  });

  it("emits failure regardless of safe_to_automerge when triage flagged injected instructions (FR-6.3)", async () => {
    const port = createFakeDecisionAdapter(script(0.99));
    const result = await runMergeGateStage({
      ...baseInput,
      decisionPort: port,
      containsInjectedInstructionsHigh: true,
    });
    expect(result.conclusion).toBe("failure");
  });

  it("never triggers an actual merge — it only returns a signal", async () => {
    const port = createFakeDecisionAdapter(script(0.95));
    const result = await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(result).not.toHaveProperty("merged");
    expect(typeof result.conclusion).toBe("string");
  });

  it("sends the published findings-by-severity and CI status in the state, computed in code", async () => {
    let capturedState: unknown;
    const port = {
      decide: async (state: unknown, questions: unknown) => {
        capturedState = state;
        return createFakeDecisionAdapter(script(0.9)).decide(state as never, questions as never);
      },
    };
    await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(capturedState).toMatchObject({
      published_findings_by_severity: { nit: 0, minor: 1, major: 0, critical: 0 },
      ci_status: "success",
    });
  });

  it("issues exactly one Jev request for the whole PR (NFR-14)", async () => {
    let calls = 0;
    const port = {
      decide: async (state: never, questions: never) => {
        calls++;
        return createFakeDecisionAdapter(script(0.9)).decide(state, questions);
      },
    };
    await runMergeGateStage({ ...baseInput, decisionPort: port });
    expect(calls).toBe(1);
  });
});
