/**
 * Wire-level (snake_case) structured-output schema for the change
 * summarizer (H7), the summarizer-side twin of
 * ../reviewers/review-output-schema.ts, plus the mapper onto the domain's
 * camelCase `ChangeSummary`. Field names are snake_case because they are
 * what the model is asked to produce (repo-wide wire convention).
 */
import { z } from "zod";
import type { ChangeSummary } from "../../domain/ports/change-summarizer-port.js";

export const summaryOutputSchema = z.object({
  what_changes: z.string().min(1),
  behavior_changes: z.array(z.string()),
  user_facing: z.boolean(),
  breaking: z.boolean(),
  areas: z.array(z.string()),
  risks: z.array(z.string()),
});

export type SummaryOutputSchema = z.infer<typeof summaryOutputSchema>;

/**
 * Plain JSON Schema form for `claude -p --json-schema`. Same `$schema`
 * stripping as review-output-schema.ts, for the same measured reason: the
 * CLI's validator rejects a schema carrying a top-level `$schema` key.
 */
function toPlainJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(summaryOutputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const SUMMARY_OUTPUT_JSON_SCHEMA: Record<string, unknown> = toPlainJsonSchema();

export function toChangeSummary(parsed: SummaryOutputSchema): ChangeSummary {
  return {
    whatChanges: parsed.what_changes,
    behaviorChanges: parsed.behavior_changes,
    userFacing: parsed.user_facing,
    breaking: parsed.breaking,
    areas: parsed.areas,
    risks: parsed.risks,
  };
}
