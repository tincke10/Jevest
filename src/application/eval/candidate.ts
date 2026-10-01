/**
 * A candidate finding: one thing a review variant showed (or hid) on a
 * case, in a shape the matcher and the metrics can compare against the
 * golden issues, whatever produced it (the pipeline, an imported review).
 *
 * Buckets (docs/EVAL.md "Buckets"): `shown` is what the PR author sees —
 * published findings, questions / needs-human, narrative points, the
 * secret warning, or every finding of an imported review; `low` is what
 * the review kept out of sight (low-confidence and discarded findings).
 */
import { z } from "zod";

export type CandidateBucket = "shown" | "low";

export type CandidateSource =
  | "finding"
  | "question"
  | "narrative"
  | "secret"
  | "low-confidence"
  | "discarded"
  | "evidence-failed"
  | "dropped"
  | "import";

export interface CandidateFinding {
  /** Unique within a run: `<caseId>:<source>:<n>`. */
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly lineEnd?: number;
  readonly text: string;
  /** The bare claim when `text` adds more (e.g. "claim — rationale"); for the matcher. */
  readonly claim?: string;
  /** How the defect shows (agentic findings, imports that carry one); for the matcher. */
  readonly failingScenario?: string;
  /** The reviewer's quotes from the code; for the matcher. */
  readonly evidence?: readonly CandidateEvidence[];
  readonly severity?: string;
  readonly kind?: string;
  readonly bucket: CandidateBucket;
  readonly source: CandidateSource;
}

export interface CandidateEvidence {
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

export class ImportedReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportedReviewError";
  }
}

const importedFindingSchema = z.object({
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  lineEnd: z.number().int().optional(),
  severity: z.string().nullish(),
  claim: z.string().optional(),
  title: z.string().optional(),
  failingScenario: z.string().nullish(),
  evidence: z
    .array(z.object({ file: z.string(), line: z.number().int(), quote: z.string() }))
    .optional(),
  kind: z.string().nullish(),
  bucket: z.enum(["shown", "low"]).optional(),
});

/** The import format (docs/EVAL.md "Importing a review"); unknown fields are ignored. */
export const importedReviewSchema = z.object({
  findings: z.array(z.unknown()),
  costUsd: z.number().nullish(),
  tokens: z.number().nullish(),
  wallTimeMs: z.number().nullish(),
});

export type ImportedReview = z.infer<typeof importedReviewSchema>;

export function parseImportedReview(value: unknown, label: string): ImportedReview {
  const parsed = importedReviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new ImportedReviewError(
      `${label}: expected { findings: [...] } (${parsed.error.message})`,
    );
  }
  return parsed.data;
}

export function candidatesFromImportedReview(value: unknown, caseId: string): CandidateFinding[] {
  const review = parseImportedReview(value, caseId);
  return review.findings.map((raw, index) => {
    const parsed = importedFindingSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportedReviewError(`${caseId} finding ${index}: ${parsed.error.message}`);
    }
    const finding = parsed.data;
    const text = finding.claim ?? finding.title;
    if (text === undefined || text.trim() === "") {
      throw new ImportedReviewError(`${caseId} finding ${index}: needs a "claim" or a "title"`);
    }
    return {
      id: `${caseId}:import:${index}`,
      file: finding.file ?? null,
      line: finding.line ?? null,
      ...(finding.lineEnd !== undefined ? { lineEnd: finding.lineEnd } : {}),
      text,
      ...(finding.failingScenario ? { failingScenario: finding.failingScenario } : {}),
      ...(finding.evidence && finding.evidence.length > 0 ? { evidence: finding.evidence } : {}),
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.kind ? { kind: finding.kind } : {}),
      bucket: finding.bucket ?? "shown",
      source: "import" as const,
    };
  });
}
