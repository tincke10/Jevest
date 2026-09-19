import { describe, expect, it } from "vitest";
import { reviewOutputSchema, toReviewFindingCandidates } from "./review-output-schema.js";

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
