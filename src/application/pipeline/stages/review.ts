/**
 * Stage 3: LLM review (SPEC FR-4). No Jev logic here — the reviewer is
 * pluggable behind ReviewerPort (provider/model from `.jevest.yml`). Each
 * eligible hunk (not skipped by hunk-profile; a hunk with a secret is
 * reviewed, its text already redacted there, NFR-3) gets its own
 * `review()` call, with its FR-3.3 profile passed as context. A budget cap
 * stops further calls once exceeded (FR-4.3); a per-hunk reviewer error is
 * recorded and the stage continues (matches the spike/filter runners'
 * fail-per-item, continue-overall pattern). The author's stated context, when
 * the pipeline has one, rides along on every hunk's ReviewInput.
 *
 * Code context (stages/code-context.ts): a hunk's full file and impact
 * context, when built, ride along on its ReviewInput; `requireEvidence`
 * asks the reviewer for evidence and checks every finding's quotes against
 * the head files (`readHeadLines`) or, without a working tree, the hunk's
 * own text (../../../domain/evidence-verifier.ts). The result lands on the
 * finding as `evidenceCheck`; the finding filter keeps a finding with no
 * verified quote from being published. With every layer off the
 * ReviewInput carries none of these keys, so recorded fixtures still match.
 */
import type { AuthorContext } from "../../../domain/author-context.js";
import { evidencePathCandidates, verifyEvidence } from "../../../domain/evidence-verifier.js";
import { languageFromPath } from "../../../domain/language.js";
import type {
  ReviewFindingCandidate,
  ReviewInput,
  ReviewUsage,
  ReviewerPort,
} from "../../../domain/ports/reviewer-port.js";
import { type ModelPricing, reviewCostUsd } from "../../findings/pricing.js";
import type { CodeContextStageResult, HeadFileReader } from "./code-context.js";
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

/** How many of a finding's evidence items were found in the code (`requireEvidence` only). */
export interface EvidenceCheckSummary {
  readonly verified: number;
  readonly checked: number;
}

export interface ReviewStageFinding extends ReviewFindingCandidate {
  /** Present only under `requireEvidence`; `verified: 0` = not published (finding-filter.ts). */
  readonly evidenceCheck?: EvidenceCheckSummary;
}

export interface ReviewStageEntry {
  readonly hunkId: string;
  readonly file: string;
  readonly findings: readonly ReviewStageFinding[];
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
  /**
   * The author's stated context (description-context.ts), the same for every
   * hunk. Absent when the description was not used or nothing was kept.
   */
  readonly authorContext?: AuthorContext;
  /** stages/code-context.ts output; a hunk's non-null layers go on its ReviewInput. */
  readonly codeContext?: CodeContextStageResult | null;
  /** `reviewer.requireEvidence`: ask for evidence and check it. */
  readonly requireEvidence?: boolean;
  /** Redacted head-file lines for the evidence check; absent = no working tree (hunk text only). */
  readonly readHeadLines?: HeadFileReader;
}

export interface ReviewStageResult {
  readonly reviews: ReviewStageEntry[];
  readonly totalCostUsd: number;
  readonly budgetExceeded: boolean;
  readonly skippedForBudgetCount: number;
}

function toReviewInput(hunk: HunkProfileEntry, input: ReviewStageInput): ReviewInput {
  const { authorContext } = input;
  const context = input.codeContext?.hunks.find((h) => h.hunkId === hunk.id);
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
    ...(authorContext ? { authorContext } : {}),
    ...(context?.fullFile ? { fullFile: context.fullFile } : {}),
    ...(context?.impactContext ? { impactContext: context.impactContext } : {}),
    ...(input.requireEvidence === true ? { requireEvidence: true as const } : {}),
  };
}

async function checkEvidence(
  findings: readonly ReviewFindingCandidate[],
  hunk: HunkProfileEntry,
  readHeadLines: HeadFileReader | undefined,
): Promise<ReviewStageFinding[]> {
  const checked: ReviewStageFinding[] = [];
  for (const finding of findings) {
    const evidence = finding.evidence ?? [];
    let headFiles: Map<string, readonly string[] | null> | null = null;
    if (readHeadLines) {
      headFiles = new Map();
      const paths = [hunk.file, ...evidence.flatMap((e) => evidencePathCandidates(e.file))];
      for (const path of new Set(paths)) headFiles.set(path, await readHeadLines(path));
    }
    const result = verifyEvidence(evidence, {
      hunk: { file: hunk.file, before: hunk.before, diff: hunk.diff },
      headFiles,
    });
    checked.push({
      ...finding,
      evidenceCheck: { verified: result.verified, checked: result.checked },
    });
  }
  return checked;
}

export async function runReviewStage(input: ReviewStageInput): Promise<ReviewStageResult> {
  const eligible = input.hunks.filter((h) => !h.skippedFromReview);

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
      const output = await input.reviewerPort.review(toReviewInput(hunk, input));
      // A subscription-billed reviewer (claude-cli) reports the CLI's own
      // nominal list-price cost; that number is what the budget cap should
      // track, not a re-computation from a per-token pricing table.
      const costUsd = output.nominalCostUsd ?? reviewCostUsd(output.usage, input.pricing);
      totalCostUsd += costUsd;

      reviews.push({
        hunkId: hunk.id,
        file: hunk.file,
        findings:
          input.requireEvidence === true
            ? await checkEvidence(output.findings, hunk, input.readHeadLines)
            : output.findings,
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
      // The comment shows a cleaned message; keep the raw error for debugging.
      console.warn(
        `jevest: reviewer failed on ${hunk.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
