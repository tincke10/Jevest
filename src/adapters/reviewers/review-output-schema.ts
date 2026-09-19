/**
 * The wire-level (snake_case) structured-output schema shared by both LLM
 * reviewer adapters (SPEC FR-4.1), plus the mapper to the domain's camelCase
 * `ReviewFindingCandidate` shape (see ../../domain/ports/reviewer-port.ts).
 * Field names are snake_case here because they are what the model is asked
 * to produce, matching the wire convention used elsewhere in this repo
 * (hunks.jsonl, findings.jsonl).
 */
import { z } from "zod";
import type { ReviewFindingCandidate } from "../../domain/ports/reviewer-port.js";

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

/** Maps the model's parsed structured output onto the port's camelCase shape. */
export function toReviewFindingCandidates(parsed: ReviewOutputSchema): ReviewFindingCandidate[] {
  return parsed.findings.map((finding) => ({
    lineStart: finding.line_start,
    lineEnd: finding.line_end,
    claim: finding.claim,
    rationale: finding.rationale,
    suggestedSeverity: finding.suggested_severity,
  }));
}
