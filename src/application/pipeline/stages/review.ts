/**
 * Stage 3: LLM review (SPEC FR-4). No Jev logic here — the reviewer is
 * pluggable behind ReviewerPort (provider/model from `.jevest.yml`). Each
 * eligible hunk (not skipped by hunk-profile, no secret) gets its own
 * `review()` call, with its FR-3.3 profile passed as context. A budget cap
 * stops further calls once exceeded (FR-4.3); a per-hunk reviewer error is
 * recorded and the stage continues (matches the spike/filter runners'
 * fail-per-item, continue-overall pattern).
 */
import { languageFromPath } from "../../../domain/language.js";
import type {
  ReviewFindingCandidate,
  ReviewInput,
  ReviewUsage,
  ReviewerPort,
} from "../../../domain/ports/reviewer-port.js";
import { type ModelPricing, reviewCostUsd } from "../../findings/pricing.js";
import type { HunkProfileEntry } from "./hunk-profile.js";

/**
 * Extensions this project's own reviewer prompt names beyond what
 * `languageFromPath` covers (that function only distinguishes the
 * languages `hunk-profile.ts`'s AST gate cares about). `.vue`/`.php`/
 * `.blade.php` are resolved via `languageFromPath` FIRST so this stage and
 * hunk-profile.ts never disagree about those; this map only fills in the
 * rest.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
};

function inferLanguage(path: string): string {
  const detected = languageFromPath(path);
  if (detected !== "other") {
    return detected;
  }
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && LANGUAGE_BY_EXTENSION[ext]) ?? "text";
}

export interface ReviewStageEntry {
  readonly hunkId: string;
  readonly file: string;
  readonly findings: readonly ReviewFindingCandidate[];
  readonly model: string | null;
  readonly usage: ReviewUsage | null;
  readonly latencyMs: number;
  readonly requestId: string | undefined;
  readonly costUsd: number;
  readonly error: string | null;
}

export interface ReviewStageInput {
  readonly hunks: readonly HunkProfileEntry[];
  readonly reviewerPort: ReviewerPort;
  readonly pricing: ModelPricing;
  readonly budgetUsd: number;
}

export interface ReviewStageResult {
  readonly reviews: ReviewStageEntry[];
  readonly totalCostUsd: number;
  readonly budgetExceeded: boolean;
  readonly skippedForBudgetCount: number;
}

function toReviewInput(hunk: HunkProfileEntry): ReviewInput {
  return {
    hunkId: hunk.id,
    file: hunk.file,
    language: inferLanguage(hunk.file),
    hunkHeader: hunk.hunkHeader,
    before: hunk.before,
    diff: hunk.diff,
    profile: {
      changeKind: hunk.changeKind,
      touchesErrorHandling: hunk.touchesErrorHandlingProb,
      touchesAsync: hunk.touchesAsyncProb,
      touchesPublicApi: hunk.touchesPublicApi,
      touchesPublicApiPartial: hunk.touchesPublicApiPartial,
      astSkipped: hunk.astSkipped,
    },
  };
}

export async function runReviewStage(input: ReviewStageInput): Promise<ReviewStageResult> {
  const eligible = input.hunks.filter((h) => !h.skippedFromReview && !h.containsSecret);

  const reviews: ReviewStageEntry[] = [];
  let totalCostUsd = 0;
  let budgetExceeded = false;
  let skippedForBudgetCount = 0;

  for (const hunk of eligible) {
    if (budgetExceeded) {
      skippedForBudgetCount++;
      continue;
    }

    try {
      const output = await input.reviewerPort.review(toReviewInput(hunk));
      // A subscription-billed reviewer (claude-cli) reports the CLI's own
      // nominal list-price cost; that number is what the budget cap should
      // track, not a re-computation from a per-token pricing table.
      const costUsd = output.nominalCostUsd ?? reviewCostUsd(output.usage, input.pricing);
      totalCostUsd += costUsd;

      reviews.push({
        hunkId: hunk.id,
        file: hunk.file,
        findings: output.findings,
        model: output.model,
        usage: output.usage,
        latencyMs: output.latencyMs,
        requestId: output.requestId,
        costUsd,
        error: null,
      });

      if (totalCostUsd >= input.budgetUsd) {
        budgetExceeded = true;
      }
    } catch (error) {
      reviews.push({
        hunkId: hunk.id,
        file: hunk.file,
        findings: [],
        model: null,
        usage: null,
        latencyMs: 0,
        requestId: undefined,
        costUsd: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { reviews, totalCostUsd, budgetExceeded, skippedForBudgetCount };
}
