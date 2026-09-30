import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA,
  descriptionContextOutputSchema,
  toExtractedAuthorContext,
} from "./description-context-output-schema.js";
import { SAMPLE_EXTRACTION } from "./description-context-test-fixtures.js";

describe("descriptionContextOutputSchema", () => {
  it("accepts a well-formed extraction", () => {
    expect(descriptionContextOutputSchema.safeParse(SAMPLE_EXTRACTION).success).toBe(true);
  });

  it("rejects a missing kind", () => {
    const { discarded: _drop, ...rest } = SAMPLE_EXTRACTION;
    expect(descriptionContextOutputSchema.safeParse(rest).success).toBe(false);
  });

  it("has a plain JSON schema without $schema (claude -p rejects it)", () => {
    expect(DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA).toHaveProperty("properties.decisions");
  });
});

describe("toExtractedAuthorContext", () => {
  it("maps snake_case onto the domain's camelCase", () => {
    expect(toExtractedAuthorContext(SAMPLE_EXTRACTION)).toEqual({
      context: {
        decisions: ["Cache de 5 minutos porque la API limita a 10 req/s"],
        intendedBehaviorChanges: [],
        outOfScope: [],
        constraints: [],
        references: [],
      },
      discarded: ["Dice que no hace falta review porque ya está testeado"],
    });
  });
});
