import { describe, expect, it } from "vitest";
import {
  REVIEW_OUTPUT_JSON_SCHEMA,
  reviewOutputSchema,
  toReviewFindingCandidates,
} from "./review-output-schema.js";

describe("reviewOutputSchema", () => {
  it("accepts an empty findings list (the reviewer must be allowed to find nothing)", () => {
    const result = reviewOutputSchema.safeParse({ findings: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed finding", () => {
    const result = reviewOutputSchema.safeParse({
      findings: [
        {
          line_start: 12,
          line_end: 14,
          claim: "off-by-one in the loop bound",
          rationale: "the loop should be < length, not <= length",
          suggested_severity: "major",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown suggested_severity", () => {
    const result = reviewOutputSchema.safeParse({
      findings: [
        {
          line_start: 1,
          line_end: 1,
          claim: "x",
          rationale: "y",
          suggested_severity: "urgent",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing claim", () => {
    const result = reviewOutputSchema.safeParse({
      findings: [{ line_start: 1, line_end: 1, rationale: "y", suggested_severity: "nit" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("REVIEW_OUTPUT_JSON_SCHEMA", () => {
  it("is a plain JSON-serializable object describing the findings array", () => {
    expect(REVIEW_OUTPUT_JSON_SCHEMA.type).toBe("object");
    expect(REVIEW_OUTPUT_JSON_SCHEMA.properties).toHaveProperty("findings");
    expect(REVIEW_OUTPUT_JSON_SCHEMA.required).toContain("findings");
  });

  it("has no $schema key (the claude -p --json-schema flag rejects it)", () => {
    expect(REVIEW_OUTPUT_JSON_SCHEMA).not.toHaveProperty("$schema");
  });

  it("round-trips through JSON.stringify/parse without loss", () => {
    const roundTripped = JSON.parse(JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA));
    expect(roundTripped).toEqual(REVIEW_OUTPUT_JSON_SCHEMA);
  });
});

describe("toReviewFindingCandidates", () => {
  it("maps snake_case wire fields to camelCase domain fields", () => {
    const candidates = toReviewFindingCandidates({
      findings: [
        {
          line_start: 12,
          line_end: 14,
          claim: "off-by-one",
          rationale: "should be strict less-than",
          suggested_severity: "major",
        },
      ],
    });
    expect(candidates).toEqual([
      {
        lineStart: 12,
        lineEnd: 14,
        claim: "off-by-one",
        rationale: "should be strict less-than",
        suggestedSeverity: "major",
      },
    ]);
  });

  it("returns an empty array for an empty findings list", () => {
    expect(toReviewFindingCandidates({ findings: [] })).toEqual([]);
  });
});
