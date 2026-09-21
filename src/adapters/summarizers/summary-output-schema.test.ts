import { describe, expect, it } from "vitest";
import {
  SUMMARY_OUTPUT_JSON_SCHEMA,
  summaryOutputSchema,
  toChangeSummary,
} from "./summary-output-schema.js";

const VALID = {
  what_changes: "Adds a retry to the login request.",
  behavior_changes: ["Login retries once on a network error."],
  user_facing: true,
  breaking: false,
  areas: ["authentication"],
  risks: ["Duplicate login attempts if the first request actually succeeded."],
};

describe("summaryOutputSchema", () => {
  it("accepts a well-formed snake_case summary", () => {
    expect(summaryOutputSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts empty lists for behavior_changes, areas and risks", () => {
    const result = summaryOutputSchema.safeParse({
      ...VALID,
      behavior_changes: [],
      areas: [],
      risks: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty what_changes", () => {
    expect(summaryOutputSchema.safeParse({ ...VALID, what_changes: "" }).success).toBe(false);
  });

  it("rejects a missing boolean", () => {
    const { breaking: _drop, ...withoutBreaking } = VALID;
    expect(summaryOutputSchema.safeParse(withoutBreaking).success).toBe(false);
  });

  it("rejects non-string list items", () => {
    expect(summaryOutputSchema.safeParse({ ...VALID, risks: [1] }).success).toBe(false);
  });
});

describe("SUMMARY_OUTPUT_JSON_SCHEMA", () => {
  it("is a plain JSON schema object without the $schema key (claude -p rejects it)", () => {
    expect(SUMMARY_OUTPUT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(SUMMARY_OUTPUT_JSON_SCHEMA.type).toBe("object");
    const properties = SUMMARY_OUTPUT_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "areas",
      "behavior_changes",
      "breaking",
      "risks",
      "user_facing",
      "what_changes",
    ]);
  });
});

describe("toChangeSummary", () => {
  it("maps snake_case wire fields onto the camelCase domain shape", () => {
    expect(toChangeSummary(summaryOutputSchema.parse(VALID))).toEqual({
      whatChanges: VALID.what_changes,
      behaviorChanges: VALID.behavior_changes,
      userFacing: true,
      breaking: false,
      areas: VALID.areas,
      risks: VALID.risks,
    });
  });
});
