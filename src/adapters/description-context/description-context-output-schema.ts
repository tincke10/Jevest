/**
 * Wire-level (snake_case) structured-output schema for the
 * description-context extractor, the extractor-side twin of
 * ../summarizers/summary-output-schema.ts, plus the mapper onto the
 * domain's camelCase `AuthorContext`. No length or count limits here on
 * purpose: several providers' structured-output modes reject `maxItems` /
 * `maxLength`, and the caps are enforced deterministically afterwards by
 * `sanitizeAuthorContext` anyway.
 */
import { z } from "zod";
import type { ExtractedAuthorContext } from "../../domain/author-context.js";

export const descriptionContextOutputSchema = z.object({
  decisions: z.array(z.string()),
  intended_behavior_changes: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  constraints: z.array(z.string()),
  references: z.array(z.string()),
  discarded: z.array(z.string()),
});

export type DescriptionContextOutputSchema = z.infer<typeof descriptionContextOutputSchema>;

/** Same `$schema` stripping as summary-output-schema.ts: `claude -p` rejects the key. */
function toPlainJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(descriptionContextOutputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const DESCRIPTION_CONTEXT_OUTPUT_JSON_SCHEMA: Record<string, unknown> = toPlainJsonSchema();

export function toExtractedAuthorContext(
  parsed: DescriptionContextOutputSchema,
): ExtractedAuthorContext {
  return {
    context: {
      decisions: parsed.decisions,
      intendedBehaviorChanges: parsed.intended_behavior_changes,
      outOfScope: parsed.out_of_scope,
      constraints: parsed.constraints,
      references: parsed.references,
    },
    discarded: parsed.discarded,
  };
}
