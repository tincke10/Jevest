import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REVIEW_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA,
  reviewOutputJsonSchemaFor,
  reviewOutputSchema,
  reviewOutputSchemaFor,
  reviewOutputWithEvidenceSchema,
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

describe("evidence schema (reviewer.hunks.requireEvidence)", () => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const finding = {
    line_start: 3,
    line_end: 3,
    claim: "the caller still passes the old flag",
    rationale: "pay.ts derives it from the legacy map",
    suggested_severity: "major" as const,
  };

  it("leaves the default JSON schema byte-identical (pinned)", () => {
    expect(sha256(JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA))).toBe(
      "1e603cca1c26983d4f13c5a0546e504e3677c03f2b07fa6125656f6db79859a2",
    );
  });

  it("requires evidence on every finding", () => {
    expect(reviewOutputWithEvidenceSchema.safeParse({ findings: [finding] }).success).toBe(false);
    expect(
      reviewOutputWithEvidenceSchema.safeParse({
        findings: [
          { ...finding, evidence: [{ file: "src/pay.ts", line: 20, quote: "legacyMap[flag]" }] },
        ],
      }).success,
    ).toBe(true);
    const json = REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA as {
      properties: { findings: { items: { required: string[] } } };
    };
    expect(json.properties.findings.items.required).toContain("evidence");
    expect(REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA).not.toHaveProperty("$schema");
  });

  it("picks the schema from the request", () => {
    const input = {
      hunkId: "h",
      file: "a.ts",
      language: "typescript",
      hunkHeader: "",
      before: "",
      diff: "",
    };
    expect(reviewOutputSchemaFor(input)).toBe(reviewOutputSchema);
    expect(reviewOutputJsonSchemaFor(input)).toBe(REVIEW_OUTPUT_JSON_SCHEMA);
    expect(reviewOutputSchemaFor({ ...input, requireEvidence: true })).toBe(
      reviewOutputWithEvidenceSchema,
    );
    expect(reviewOutputJsonSchemaFor({ ...input, requireEvidence: true })).toBe(
      REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA,
    );
  });

  it("maps evidence onto the candidate, and leaves it off when absent", () => {
    expect(
      toReviewFindingCandidates({
        findings: [{ ...finding, evidence: [{ file: "src/pay.ts", line: 20, quote: "x()" }] }],
      })[0]?.evidence,
    ).toEqual([{ file: "src/pay.ts", line: 20, quote: "x()" }]);
    expect(toReviewFindingCandidates({ findings: [finding] })[0]).not.toHaveProperty("evidence");
  });
});
