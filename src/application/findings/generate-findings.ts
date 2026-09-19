/**
 * Runs the phase 1a findings generation over a set of hunks against any
 * ReviewerPort (fake, or a real LLM adapter). SPEC §5 Fase 1a step 2: one
 * reviewer call per hunk, labeled by line-overlap against the fix, cost
 * accumulated against a budget. A hunk whose review call throws is recorded
 * as a failure and the run continues (same "keep going, report what
 * couldn't be processed" shape as ../spike/spike-runner.ts).
 */
import type { FindingRecord, ReviewerProvider } from "../../domain/finding.js";
import { computeFixChangedLines, labelFinding } from "../../domain/line-overlap.js";
import type { ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { type ModelPricing, reviewCostUsd } from "./pricing.js";

export interface GenerateFindingsFailure {
  readonly hunkId: string;
  readonly error: string;
}

export interface GenerateFindingsResult {
  readonly records: FindingRecord[];
  readonly failures: GenerateFindingsFailure[];
  /** Hunks the run actually called the reviewer for (successes + failures). */
  readonly hunksAttempted: number;
  /** Hunks never attempted because the budget was already exceeded. */
  readonly hunksSkippedByBudget: number;
  readonly totalCostUsd: number;
}

export interface GenerateFindingsOptions {
  readonly hunks: readonly HunkRecord[];
  readonly reviewer: ReviewerPort;
  readonly provider: ReviewerProvider;
  readonly pricing: ModelPricing;
  /** Stops the run (before starting the next hunk) once total cost reaches this. */
  readonly budgetUsd: number;
}

export async function generateFindings(
  options: GenerateFindingsOptions,
): Promise<GenerateFindingsResult> {
  const records: FindingRecord[] = [];
  const failures: GenerateFindingsFailure[] = [];
  let totalCostUsd = 0;
  let hunksAttempted = 0;

  for (const hunk of options.hunks) {
    if (totalCostUsd >= options.budgetUsd) {
      break;
    }
    hunksAttempted += 1;

    try {
      const output = await options.reviewer.review({
        hunkId: hunk.id,
        file: hunk.file,
        language: hunk.language,
        hunkHeader: hunk.hunkHeader,
        before: hunk.before,
        diff: hunk.diff,
      });

      totalCostUsd += reviewCostUsd(output.usage, options.pricing);

      const fixChangedLines = computeFixChangedLines(hunk.diff, hunk.hunkHeader);

      output.findings.forEach((finding, index) => {
        const label = labelFinding(finding, fixChangedLines, hunk.label.defect);
        records.push({
          id: `${hunk.id}::${options.provider}::${index}`,
          hunkId: hunk.id,
          datasetVersion: 2,
          reviewer: { provider: options.provider, model: output.model },
          file: hunk.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          claim: finding.claim,
          rationale: finding.rationale,
          suggestedSeverity: finding.suggestedSeverity,
          label,
          needsManualReview: true,
          usage: output.usage,
          costUsd: reviewCostUsd(output.usage, options.pricing),
          latencyMs: output.latencyMs,
        });
      });
    } catch (error) {
      failures.push({
        hunkId: hunk.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    records,
    failures,
    hunksAttempted,
    hunksSkippedByBudget: options.hunks.length - hunksAttempted,
    totalCostUsd,
  };
}
