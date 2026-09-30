import { describe, expect, it } from "vitest";
import {
  NARRATIVE_OUTPUT_JSON_SCHEMA,
  narrativeOutputSchema,
  toNarrativeMarkdown,
} from "./narrative-output-schema.js";

describe("narrativeOutputSchema", () => {
  it("accepts a non-empty review string", () => {
    expect(narrativeOutputSchema.safeParse({ review: "Looks good." }).success).toBe(true);
  });

  it("rejects an empty or missing review", () => {
    expect(narrativeOutputSchema.safeParse({ review: "" }).success).toBe(false);
    expect(narrativeOutputSchema.safeParse({}).success).toBe(false);
  });

  it("maps to trimmed markdown", () => {
    expect(toNarrativeMarkdown({ review: "\n  Looks good.\n" })).toBe("Looks good.");
  });
});

describe("NARRATIVE_OUTPUT_JSON_SCHEMA", () => {
  it("is a plain JSON schema with a review string and no top-level $schema (claude -p rejects it)", () => {
    expect(NARRATIVE_OUTPUT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(NARRATIVE_OUTPUT_JSON_SCHEMA).toHaveProperty("properties.review.type", "string");
  });
});
