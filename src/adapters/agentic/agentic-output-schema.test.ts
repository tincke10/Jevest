import { describe, expect, it } from "vitest";
import {
  AGENTIC_REVIEW_JSON_SCHEMA,
  FINDING_VERIFICATION_JSON_SCHEMA,
  agenticReviewOutputSchema,
  findingVerificationSchema,
  toAgenticFindings,
} from "./agentic-output-schema.js";

const valid = {
  findings: [
    {
      file: "src/a.ts",
      line: 12,
      lineEnd: 14,
      category: "correctness",
      severity: "high",
      claim: "Off by one.",
      failingScenario: "n=3 -> sums 2 items.",
      evidence: [{ file: "src/a.ts", line: 12, quote: "i < n - 1" }],
      confidence: 0.9,
    },
  ],
};

describe("agenticReviewOutputSchema", () => {
  it("accepts the documented shape and an empty findings list", () => {
    expect(agenticReviewOutputSchema.safeParse(valid).success).toBe(true);
    expect(agenticReviewOutputSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it("rejects an unknown category or severity and a confidence outside 0..1", () => {
    const finding = valid.findings[0];
    for (const bad of [
      { ...finding, category: "style" },
      { ...finding, severity: "nit" },
      { ...finding, confidence: 1.5 },
    ]) {
      expect(agenticReviewOutputSchema.safeParse({ findings: [bad] }).success).toBe(false);
    }
  });

  it("is a plain JSON schema for --json-schema (no $schema key) that names every field", () => {
    expect(AGENTIC_REVIEW_JSON_SCHEMA).not.toHaveProperty("$schema");
    const text = JSON.stringify(AGENTIC_REVIEW_JSON_SCHEMA);
    for (const field of ["failingScenario", "evidence", "quote", "confidence", "category"]) {
      expect(text).toContain(field);
    }
  });
});

describe("toAgenticFindings", () => {
  it("keeps lineEnd only when given and at most three evidence items", () => {
    const parsed = agenticReviewOutputSchema.parse({
      findings: [
        {
          ...valid.findings[0],
          lineEnd: undefined,
          evidence: [1, 2, 3, 4].map((line) => ({ file: "src/a.ts", line, quote: `q${line}xx` })),
        },
      ],
    });
    const [finding] = toAgenticFindings(parsed);
    expect(finding).not.toHaveProperty("lineEnd");
    expect(finding?.evidence).toHaveLength(3);
  });
});

describe("findingVerificationSchema", () => {
  it("accepts confirmed, refuted and uncertain with a reason and evidence", () => {
    for (const decision of ["confirmed", "refuted", "uncertain"]) {
      expect(
        findingVerificationSchema.safeParse({
          decision,
          reason: "because",
          evidence: [{ file: "a.ts", line: 1, quote: "code" }],
        }).success,
      ).toBe(true);
    }
    expect(
      findingVerificationSchema.safeParse({ decision: "maybe", reason: "", evidence: [] }).success,
    ).toBe(false);
    expect(FINDING_VERIFICATION_JSON_SCHEMA).not.toHaveProperty("$schema");
  });
});
