/**
 * Wire-level (snake_case-free, the shape is already flat) structured-output
 * schema for the fix-aware oracle labeler, the labeler-side twin of
 * ../judges/judge-output-schema.ts. One schema per framing so a model that
 * answers in the other framing's vocabulary is a loud parse failure, never a
 * verdict quietly coerced into the wrong axis.
 *
 * `confidence` is bounded to [0, 1] at the schema for the same reason the
 * judge's probability is: an out-of-range answer is a signal, not something
 * to clamp. `reason` is required — an oracle label nobody can audit afterwards
 * is worse than no label, since it looks like ground truth.
 */
import { z } from "zod";
import type { LabelerFraming } from "../../domain/ports/finding-labeler-port.js";

const shared = {
  confidence: z.number().min(0).max(1),
  reason: z.string(),
};

/** Pass A: does the finding describe the defect this commit fixed? */
export const fixMatchOutputSchema = z.object({
  verdict: z.enum(["real", "not-this", "unclear"]),
  ...shared,
});

/** Pass B: is the claimed problem present in the BEFORE code? */
export const claimVerificationOutputSchema = z.object({
  verdict: z.enum(["present", "absent", "unclear"]),
  ...shared,
});

export type FixMatchOutputSchema = z.infer<typeof fixMatchOutputSchema>;
export type ClaimVerificationOutputSchema = z.infer<typeof claimVerificationOutputSchema>;

export function labelerOutputSchemaFor(framing: "fix-match"): typeof fixMatchOutputSchema;
export function labelerOutputSchemaFor(
  framing: "claim-verification",
): typeof claimVerificationOutputSchema;
export function labelerOutputSchemaFor(
  framing: LabelerFraming,
): typeof fixMatchOutputSchema | typeof claimVerificationOutputSchema;
export function labelerOutputSchemaFor(
  framing: LabelerFraming,
): typeof fixMatchOutputSchema | typeof claimVerificationOutputSchema {
  return framing === "fix-match" ? fixMatchOutputSchema : claimVerificationOutputSchema;
}

/** Plain JSON Schema for `claude -p --json-schema`; `$schema` stripped for the same reason as the judge's. */
function toPlainJsonSchema(framing: LabelerFraming): Record<string, unknown> {
  const schema = z.toJSONSchema(labelerOutputSchemaFor(framing)) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

const LABELER_OUTPUT_JSON_SCHEMAS: Record<LabelerFraming, Record<string, unknown>> = {
  "fix-match": toPlainJsonSchema("fix-match"),
  "claim-verification": toPlainJsonSchema("claim-verification"),
};

/**
 * The framing's schema as plain JSON, for the claude-cli labeler's
 * `--json-schema`. One per framing, so the CLI itself enforces the separation
 * the zod schemas enforce for DeepSeek: a pass cannot answer in the other's
 * vocabulary even by accident.
 */
export function labelerOutputJsonSchemaFor(framing: LabelerFraming): Record<string, unknown> {
  return LABELER_OUTPUT_JSON_SCHEMAS[framing];
}
