/**
 * Structured outputs of the agentic reviewer and the per-finding verifier
 * (`reviewer.mode: agentic`), as zod schemas for validation and plain JSON
 * Schemas for `claude -p --json-schema` (the CLI rejects zod's top-level
 * `$schema` key, same as review-output-schema.ts).
 */
import { z } from "zod";
import {
  AGENTIC_CATEGORIES,
  AGENTIC_SEVERITIES,
  type AgenticFinding,
} from "../../domain/agentic-finding.js";
import { MAX_EVIDENCE_ITEMS } from "../../domain/evidence-verifier.js";

/** Longest quote kept; the prompt asks for ≤ 200 characters. */
export const MAX_AGENTIC_QUOTE_CHARS = 200;

const evidenceItemSchema = z.object({
  file: z.string().min(1).describe("Repository-relative path the quote comes from."),
  line: z.number().int().min(1).describe("Line of the quote in that file at the PR head."),
  quote: z
    .string()
    .min(1)
    .describe(`Code copied exactly from the file, at most ${MAX_AGENTIC_QUOTE_CHARS} characters.`),
});

const agenticFindingFields = {
  file: z.string().min(1).describe("Repository-relative path of the problem."),
  line: z.number().int().min(1).describe("Line at the PR head."),
  lineEnd: z.number().int().min(1).optional(),
  category: z.enum(AGENTIC_CATEGORIES),
  severity: z.enum(AGENTIC_SEVERITIES),
  claim: z.string().min(1).describe("One or two sentences: what is wrong."),
  failingScenario: z
    .string()
    .min(1)
    .describe("Concrete input or state -> the wrong result it produces."),
  confidence: z.number().min(0).max(1),
};

/**
 * What the CLI is asked for (1–3 evidence items). Parsing is lenient on
 * the count: extra items are cut to three, and a finding with none is
 * dropped later by the hard exclusions with a visible reason, instead of
 * failing the whole run on one malformed finding.
 */
const strictOutputSchema = z.object({
  findings: z.array(
    z.object({
      ...agenticFindingFields,
      evidence: z.array(evidenceItemSchema).min(1).max(MAX_EVIDENCE_ITEMS),
    }),
  ),
});

export const agenticReviewOutputSchema = z.object({
  findings: z.array(z.object({ ...agenticFindingFields, evidence: z.array(evidenceItemSchema) })),
});
export type AgenticReviewOutputParsed = z.infer<typeof agenticReviewOutputSchema>;

export const findingVerificationSchema = z.object({
  decision: z.enum(["confirmed", "refuted", "uncertain"]),
  reason: z.string().describe("One or two sentences, citing the code that decided it."),
  evidence: z.array(evidenceItemSchema),
});
export type FindingVerificationParsed = z.infer<typeof findingVerificationSchema>;

function toPlainJsonSchema(schemaObject: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(schemaObject) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const AGENTIC_REVIEW_JSON_SCHEMA: Record<string, unknown> =
  toPlainJsonSchema(strictOutputSchema);
export const FINDING_VERIFICATION_JSON_SCHEMA: Record<string, unknown> =
  toPlainJsonSchema(findingVerificationSchema);

function cutQuote(quote: string): string {
  return quote.length > MAX_AGENTIC_QUOTE_CHARS ? quote.slice(0, MAX_AGENTIC_QUOTE_CHARS) : quote;
}

/** Domain findings from a validated output: at most three evidence items, quotes capped. */
export function toAgenticFindings(parsed: AgenticReviewOutputParsed): AgenticFinding[] {
  return parsed.findings.map((f) => ({
    file: f.file,
    line: f.line,
    ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
    category: f.category,
    severity: f.severity,
    claim: f.claim,
    failingScenario: f.failingScenario,
    evidence: f.evidence
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map((e) => ({ file: e.file, line: e.line, quote: cutQuote(e.quote) })),
    confidence: f.confidence,
  }));
}
