import { describe, expect, it } from "vitest";
import {
  claimVerificationOutputSchema,
  fixMatchOutputSchema,
  labelerOutputJsonSchemaFor,
  labelerOutputSchemaFor,
} from "./labeler-output-schema.js";

describe("fixMatchOutputSchema", () => {
  it("accepts the three fix-match verdicts with a bounded confidence and a reason", () => {
    for (const verdict of ["real", "not-this", "unclear"]) {
      const parsed = fixMatchOutputSchema.safeParse({ verdict, confidence: 0.9, reason: "why" });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects the other framing's vocabulary", () => {
    expect(
      fixMatchOutputSchema.safeParse({ verdict: "present", confidence: 0.5, reason: "r" }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range confidence rather than clamping it silently", () => {
    expect(
      fixMatchOutputSchema.safeParse({ verdict: "real", confidence: 1.4, reason: "r" }).success,
    ).toBe(false);
    expect(
      fixMatchOutputSchema.safeParse({ verdict: "real", confidence: -0.1, reason: "r" }).success,
    ).toBe(false);
  });

  it("requires the reason: an unauditable oracle label is worse than none", () => {
    expect(fixMatchOutputSchema.safeParse({ verdict: "real", confidence: 0.5 }).success).toBe(
      false,
    );
  });
});

describe("claimVerificationOutputSchema", () => {
  it("accepts the three claim-verification verdicts", () => {
    for (const verdict of ["present", "absent", "unclear"]) {
      const parsed = claimVerificationOutputSchema.safeParse({
        verdict,
        confidence: 0.1,
        reason: "why",
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects the other framing's vocabulary", () => {
    expect(
      claimVerificationOutputSchema.safeParse({ verdict: "not-this", confidence: 0.5, reason: "r" })
        .success,
    ).toBe(false);
  });
});

describe("labelerOutputSchemaFor", () => {
  it("picks the schema by framing", () => {
    expect(labelerOutputSchemaFor("fix-match")).toBe(fixMatchOutputSchema);
    expect(labelerOutputSchemaFor("claim-verification")).toBe(claimVerificationOutputSchema);
  });
});

describe("labelerOutputJsonSchemaFor", () => {
  it("emits a plain JSON schema per framing, with $schema stripped for `claude -p --json-schema`", () => {
    const schema = labelerOutputJsonSchemaFor("fix-match");
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toHaveProperty("properties.verdict");
    expect(schema).toHaveProperty("properties.confidence");
    expect(schema).toHaveProperty("properties.reason");
  });

  it("carries each framing's own verdict vocabulary, so one can never answer as the other", () => {
    const fixMatch = labelerOutputJsonSchemaFor("fix-match") as {
      properties: { verdict: { enum: string[] } };
    };
    const claim = labelerOutputJsonSchemaFor("claim-verification") as {
      properties: { verdict: { enum: string[] } };
    };
    expect(fixMatch.properties.verdict.enum).toEqual(["real", "not-this", "unclear"]);
    expect(claim.properties.verdict.enum).toEqual(["present", "absent", "unclear"]);
  });
});
