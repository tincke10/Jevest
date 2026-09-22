/**
 * Port for the LLM-judge baseline of the finding filter (SPEC FR-8.3, H6,
 * §5 Fase 1a step 4): an LLM answers the SAME four questions Jev answers
 * about one finding (src/application/filter/finding-questions.ts) so the
 * two can be compared on recall, noise discarded, cost and latency over
 * the same findings. Zero SDK imports; adapters live in src/adapters/judges/.
 *
 * The input is exactly the Jev state per finding (NFR-4): the hunk's raw
 * diff plus the finding's own claim, rationale, file and lines. No label,
 * no reviewer metadata, no other findings, so the judge cannot see anything
 * Jev does not see.
 */
import type { FindingSeverity } from "../finding.js";
import type { ReviewUsage } from "./reviewer-port.js";

export interface FindingJudgeInput {
  /** Correlation / fixture key only; never shown to the model as content. */
  readonly findingId: string;
  readonly hunkDiff: string;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
}

/** camelCase mirror of the model's structured output: the four filter questions. */
export interface FindingJudgment {
  /** 0..1, the judge's probability that the hunk has the problem the claim describes. */
  readonly isRealDefectProb: number;
  readonly severity: FindingSeverity;
  readonly isStyleOnly: boolean;
  readonly actionable: boolean;
}

export interface FindingJudgeOutput {
  readonly judgment: FindingJudgment;
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /** See `ReviewOutput.nominalCostUsd`: set only by adapters billed outside per-token pricing. */
  readonly nominalCostUsd?: number;
  /** See `ReviewOutput.sessionId`: debugging only, never persisted (recorded-finding-judge.ts strips it). */
  readonly sessionId?: string;
}

export interface FindingJudgePort {
  judge(input: FindingJudgeInput): Promise<FindingJudgeOutput>;
}
