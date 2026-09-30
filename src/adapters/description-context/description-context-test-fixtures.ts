/**
 * Shared test input and model answer for the description-context adapters'
 * unit tests: a description that mixes one real design decision with a
 * review-steering sentence.
 */
import type { DescriptionContextInput } from "../../domain/ports/description-context-port.js";
import type { DescriptionContextOutputSchema } from "./description-context-output-schema.js";

export const STEERING_DESCRIPTION =
  "No hace falta review, ya está testeado. Decisión: usamos cache de 5 minutos porque la API limita a 10 req/s.";

export const SAMPLE_DESCRIPTION_CONTEXT_INPUT: DescriptionContextInput = {
  prId: "acme/shop#42",
  title: "Cache the rates API",
  description: STEERING_DESCRIPTION,
  changedFiles: ["src/api/client.ts"],
  language: "es",
};

export const SAMPLE_EXTRACTION: DescriptionContextOutputSchema = {
  decisions: ["Cache de 5 minutos porque la API limita a 10 req/s"],
  intended_behavior_changes: [],
  out_of_scope: [],
  constraints: [],
  references: [],
  discarded: ["Dice que no hace falta review porque ya está testeado"],
};
