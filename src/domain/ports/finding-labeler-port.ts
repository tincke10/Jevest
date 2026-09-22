/**
 * Port for the fix-aware ORACLE label of a review finding (datasets/FINDINGS.md
 * §10). It exists because the line-overlap label (§2) turned out not to measure
 * "is this finding a real defect": Jev (AUC 0.592) and a DeepSeek reasoning
 * judge (AUC 0.567) are both at chance against it (docs/BENCHMARK.md,
 * "Reading: the label, not the filter, is what failed").
 *
 * The labeler is NOT the judge with a different prompt. The judge
 * (./finding-judge-port.ts) sees exactly what Jev sees: the hunk's diff and
 * the finding. The labeler additionally sees the FUTURE of that hunk — the
 * code after the real fix, the fix's commit message and, when it exists, the
 * linked issue or pull request. That is strictly more information than either
 * scored side ever had, which is what makes the label independent rather than
 * circular.
 *
 * Two framings are asked of the same model, and only their agreement produces
 * a decisive label (see ../../application/findings/oracle-label.ts):
 *
 * - "fix-match": does this finding describe the problem the fix actually
 *   fixed? -> "real" | "not-this" | "unclear".
 * - "claim-verification": with the fix, its message and the issue in hand, is
 *   the problem the finding claims present in the BEFORE code? ->
 *   "present" | "absent" | "unclear".
 *
 * Zero SDK imports; adapters live in src/adapters/labelers/.
 */
import type { ReviewUsage } from "./reviewer-port.js";

/** Which of the two independent framings a call asks for. */
export type LabelerFraming = "fix-match" | "claim-verification";

export const LABELER_FRAMINGS: readonly LabelerFraming[] = ["fix-match", "claim-verification"];

/** Pass A: does the finding describe the defect this commit fixed? */
export type FixMatchVerdict = "real" | "not-this" | "unclear";

/** Pass B: is the claimed problem present in the BEFORE code? */
export type ClaimVerificationVerdict = "present" | "absent" | "unclear";

/**
 * Everything one labeler call is shown. The line-overlap label, Jev's answers
 * and the judge's answers are deliberately absent: a labeler that saw them
 * could only reproduce them.
 */
export interface FindingLabelerInput {
  /** Correlation / fixture key only; never shown to the model as content. */
  readonly findingId: string;
  readonly claim: string;
  readonly rationale: string;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly hunkHeader: string;
  readonly language: string;
  /** The code as the reviewer saw it, before the fix. */
  readonly before: string;
  /** The code after the real fix — the information the reviewer never had. */
  readonly after: string;
  readonly commitMessage: string;
  /** `hunks.jsonl`'s own (commit-heuristic) defect label for this hunk. */
  readonly hunkIsDefect: boolean;
  readonly issueTitle?: string;
  readonly issueBody?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
}

/** One labeler call's answer. `V` is the verdict vocabulary of its framing. */
export interface LabelerCallOutput<V extends string> {
  readonly framing: LabelerFraming;
  readonly verdict: V;
  /** The model's own 0..1 confidence in this verdict. */
  readonly confidence: number;
  /** One sentence, kept in the dataset so every oracle label can be audited. */
  readonly reason: string;
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /** See `ReviewOutput.nominalCostUsd`: set only by adapters billed outside per-token pricing. */
  readonly nominalCostUsd?: number;
  /** See `ReviewOutput.sessionId`: debugging only, never persisted. */
  readonly sessionId?: string;
}

export type FixMatchOutput = LabelerCallOutput<FixMatchVerdict>;
export type ClaimVerificationOutput = LabelerCallOutput<ClaimVerificationVerdict>;
export type FindingLabelerOutput = FixMatchOutput | ClaimVerificationOutput;

export interface FindingLabelerPort {
  labelFixMatch(input: FindingLabelerInput): Promise<FixMatchOutput>;
  labelClaimVerification(input: FindingLabelerInput): Promise<ClaimVerificationOutput>;
}
