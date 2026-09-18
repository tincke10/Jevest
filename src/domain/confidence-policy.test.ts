import { describe, expect, it } from "vitest";
import {
  type ConfidencePolicyConfig,
  ConfidencePolicyConfigError,
  createConfidencePolicy,
} from "./confidence-policy.js";

const config: ConfidencePolicyConfig = {
  triage: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
    high: { autoMin: 0.99, confirmMin: 0.8 },
  },
  merge_gate: {
    low: { autoMin: 0.95, confirmMin: 0.7 },
  },
};

describe("createConfidencePolicy", () => {
  it("bands a confidence at or above autoMin as auto", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 0.9)).toBe("auto");
    expect(policy.band("triage", "low", 0.95)).toBe("auto");
  });

  it("bands a confidence just below autoMin as confirm", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 0.899999)).toBe("confirm");
  });

  it("bands a confidence at confirmMin as confirm", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 0.6)).toBe("confirm");
  });

  it("bands a confidence just below confirmMin as escalate", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 0.599999)).toBe("escalate");
  });

  it("bands a confidence of 0 as escalate", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 0)).toBe("escalate");
  });

  it("bands a confidence of 1 as auto", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("triage", "low", 1)).toBe("auto");
  });

  it("resolves thresholds independently per stage", () => {
    const policy = createConfidencePolicy(config);
    // 0.9 is auto for triage/low but only confirm for triage/high (autoMin 0.99)
    expect(policy.band("triage", "high", 0.9)).toBe("confirm");
  });

  it("resolves thresholds independently per risk level within a stage", () => {
    const policy = createConfidencePolicy(config);
    expect(policy.band("merge_gate", "low", 0.96)).toBe("auto");
  });

  it("throws when the stage is not configured", () => {
    const policy = createConfidencePolicy(config);
    expect(() => policy.band("hunk_select", "low", 0.9)).toThrow(ConfidencePolicyConfigError);
  });

  it("throws when the risk level is not configured for a known stage", () => {
    const policy = createConfidencePolicy(config);
    expect(() => policy.band("merge_gate", "critical", 0.9)).toThrow(ConfidencePolicyConfigError);
  });

  it("throws on a confidence below 0", () => {
    const policy = createConfidencePolicy(config);
    expect(() => policy.band("triage", "low", -0.1)).toThrow(RangeError);
  });

  it("throws on a confidence above 1", () => {
    const policy = createConfidencePolicy(config);
    expect(() => policy.band("triage", "low", 1.1)).toThrow(RangeError);
  });

  it("throws when constructed with an empty config", () => {
    const policy = createConfidencePolicy({});
    expect(() => policy.band("triage", "low", 0.9)).toThrow(ConfidencePolicyConfigError);
  });
});
