/**
 * Wire-level (snake_case) structured-output schema for the LLM finding
 * judge (H6), the judge-side twin of ../reviewers/review-output-schema.ts,
 * plus the mapper onto the domain's camelCase `FindingJudgment`. The
 * probability is bounded to [0, 1] at the schema so an out-of-range answer
 * is a loud parse failure, never a silently clamped one.
 */
import { z } from "zod";
import type { FindingJudgment } from "../../domain/ports/finding-judge-port.js";

export const judgeOutputSchema = z.object({
  is_real_defect_probability: z.number().min(0).max(1),
  severity: z.enum(["nit", "minor", "major", "critical"]),
  is_style_only: z.boolean(),
  actionable: z.boolean(),
});

export type JudgeOutputSchema = z.infer<typeof judgeOutputSchema>;

/** Plain JSON Schema for `claude -p --json-schema`; `$schema` stripped for the same reason as the reviewer's. */
function toPlainJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(judgeOutputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export const JUDGE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = toPlainJsonSchema();

export function toFindingJudgment(parsed: JudgeOutputSchema): FindingJudgment {
  return {
    isRealDefectProb: parsed.is_real_defect_probability,
    severity: parsed.severity,
    isStyleOnly: parsed.is_style_only,
    actionable: parsed.actionable,
  };
}
