/**
 * The wire-level (snake_case) structured-output schema shared by both LLM
 * reviewer adapters (SPEC FR-4.1), plus the mapper to the domain's camelCase
 * `ReviewFindingCandidate` shape (see ../../domain/ports/reviewer-port.ts).
 * Field names are snake_case here because they are what the model is asked
 * to produce, matching the wire convention used elsewhere in this repo
 * (hunks.jsonl, findings.jsonl).
 */
import { z } from "zod";
import type { ReviewFindingCandidate, ReviewInput } from "../../domain/ports/reviewer-port.js";

export const reviewFindingSchema = z.object({
  line_start: z.number().int(),
  line_end: z.number().int(),
  claim: z.string().min(1),
  rationale: z.string().min(1),
  suggested_severity: z.enum(["nit", "minor", "major", "critical"]),
});

export const reviewOutputSchema = z.object({
  findings: z.array(reviewFindingSchema),
});

export type ReviewOutputSchema = z.infer<typeof reviewOutputSchema>;

/**
 * `reviewer.requireEvidence`: the same finding plus a REQUIRED `evidence`
 * list. The 1–3 items and the 200-char quote cap are prompt rules, not
 * schema constraints, on purpose: a provider that rejects or truncates on
 * `maxItems`/`maxLength` would turn one over-long quote into a failed hunk.
 * The verifier (../../domain/evidence-verifier.ts) checks only the first 3
 * items, and a quote that is not real code never verifies anyway.
 */
export const reviewEvidenceSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  quote: z.string(),
});

export const reviewFindingWithEvidenceSchema = reviewFindingSchema.extend({
  evidence: z.array(reviewEvidenceSchema),
});

export const reviewOutputWithEvidenceSchema = z.object({
  findings: z.array(reviewFindingWithEvidenceSchema),
});

export type ReviewOutputWithEvidenceSchema = z.infer<typeof reviewOutputWithEvidenceSchema>;

/**
 * Plain JSON Schema form of {@link reviewOutputSchema}, for callers that
 * can't take a Zod object directly (the `claude -p --json-schema` flag
 * wants a JSON Schema string). `zod` v4 ships `z.toJSONSchema`; its output
 * includes a top-level `$schema` key that the CLI's validator rejects
 * ("not a valid JSON Schema: no schema with key or ref ..."), confirmed by
 * a real `claude -p` call — so it's stripped here, once, for every caller.
 */
function toPlainJsonSchema(schemaObject: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(schemaObject) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const REVIEW_OUTPUT_JSON_SCHEMA: Record<string, unknown> =
  toPlainJsonSchema(reviewOutputSchema);

export const REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA: Record<string, unknown> = toPlainJsonSchema(
  reviewOutputWithEvidenceSchema,
);

/** The output schema a request asks for: with `evidence` only under `requireEvidence`. */
export function reviewOutputSchemaFor(
  input: ReviewInput,
): typeof reviewOutputSchema | typeof reviewOutputWithEvidenceSchema {
  return input.requireEvidence === true ? reviewOutputWithEvidenceSchema : reviewOutputSchema;
}

/** JSON Schema form of {@link reviewOutputSchemaFor}. */
export function reviewOutputJsonSchemaFor(input: ReviewInput): Record<string, unknown> {
  return input.requireEvidence === true
    ? REVIEW_OUTPUT_WITH_EVIDENCE_JSON_SCHEMA
    : REVIEW_OUTPUT_JSON_SCHEMA;
}

type WireFinding = ReviewOutputSchema["findings"][number] & {
  readonly evidence?: readonly { file: string; line: number; quote: string }[];
};

/** Maps the model's parsed structured output onto the port's camelCase shape. */
export function toReviewFindingCandidates(parsed: {
  readonly findings: readonly WireFinding[];
}): ReviewFindingCandidate[] {
  return parsed.findings.map((finding) => ({
    lineStart: finding.line_start,
    lineEnd: finding.line_end,
    claim: finding.claim,
    rationale: finding.rationale,
    suggestedSeverity: finding.suggested_severity,
    ...(finding.evidence !== undefined
      ? {
          evidence: finding.evidence.map((e) => ({ file: e.file, line: e.line, quote: e.quote })),
        }
      : {}),
  }));
}
