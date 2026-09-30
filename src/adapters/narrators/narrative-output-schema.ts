/**
 * Structured output for the review narrator: one `review` string holding
 * the markdown body. A plain-text reply would do for most providers, but a
 * one-field schema lets every adapter reuse the exact structured-output
 * path its summarizer twin already has (`claude -p --json-schema`,
 * `zodOutputFormat`, `zodResponseFormat`, DeepSeek's json_object), with
 * the same validation and the same errors.
 */
import { z } from "zod";

export const narrativeOutputSchema = z.object({
  review: z.string().min(1),
});

export type NarrativeOutputSchema = z.infer<typeof narrativeOutputSchema>;

/** Same `$schema` stripping as summary-output-schema.ts: `claude -p` rejects the key. */
function toPlainJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(narrativeOutputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const NARRATIVE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = toPlainJsonSchema();

export function toNarrativeMarkdown(parsed: NarrativeOutputSchema): string {
  return parsed.review.trim();
}
