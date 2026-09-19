/**
 * Port for the LLM code reviewer (SPEC FR-4, §5 Fase 1a step 1). Zero SDK
 * imports: the Anthropic and OpenAI adapters implement this behind a
 * provider-agnostic seam, matching the DecisionPort/adapter split in
 * ../ports/decision-port.ts.
 */
import type { FindingSeverity } from "../finding.js";

/** One hunk of context to review, plus its Fase 0b-style surface profile (FR-3.3), if any. */
export interface ReviewInput {
  readonly hunkId: string;
  readonly file: string;
  readonly language: string;
  readonly hunkHeader: string;
  readonly before: string;
  readonly diff: string;
  /** Optional hunk-profile context (change_kind, touches_*) the reviewer can use, never mandatory. */
  readonly profile?: Record<string, unknown>;
}

/**
 * One defect the reviewer claims to have found. `lineStart`/`lineEnd` are
 * absolute BEFORE-side line numbers (FR-4.1), derived by the reviewer from
 * `ReviewInput.hunkHeader`. An empty `findings` array on {@link ReviewOutput}
 * is the expected, valid answer when the reviewer finds nothing — reviewers
 * must never be forced to report at least one finding.
 */
export interface ReviewFindingCandidate {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
  readonly suggestedSeverity: FindingSeverity;
}

/** Token usage for one review request, camelCase mirror of the provider's snake_case usage block. */
export interface ReviewUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface ReviewOutput {
  readonly findings: readonly ReviewFindingCandidate[];
  readonly model: string;
  readonly usage: ReviewUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  /**
   * Set only by a reviewer billed outside per-token API pricing (e.g. the
   * claude-cli adapter, billed against a Claude subscription): the
   * provider's own nominal list-price cost for the call, to use as-is
   * instead of computing cost from `usage` + a pricing table. Absent means
   * "compute cost normally from usage."
   */
  readonly nominalCostUsd?: number;
  /**
   * Set only by adapters that run as a session-oriented CLI (claude-cli).
   * For observability/debugging only — never persist this (a fixture or
   * dataset record must not carry it; see recorded-reviewer.ts).
   */
  readonly sessionId?: string;
}

export interface ReviewerPort {
  review(input: ReviewInput): Promise<ReviewOutput>;
}
