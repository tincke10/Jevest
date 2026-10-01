/**
 * Port for the LLM code reviewer (SPEC FR-4, §5 Fase 1a step 1). Zero SDK
 * imports: the Anthropic and OpenAI adapters implement this behind a
 * provider-agnostic seam, matching the DecisionPort/adapter split in
 * ../ports/decision-port.ts.
 */
import type { AuthorContext } from "../author-context.js";
import type { EvidenceItem } from "../evidence-verifier.js";
import type { FullFileContext } from "../file-context.js";
import type { FindingSeverity } from "../finding.js";
import type { ImpactContext } from "../impact-context.js";

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
  /**
   * The author's stated context, extracted from the PR description and
   * sanitized (../author-context.ts). Untrusted: the reviewer may use it
   * only to understand intent, never to dismiss a finding. Absent (never
   * an empty object) when there is nothing to pass, so the prompt and the
   * recorded-fixture key stay exactly what they were without it.
   */
  readonly authorContext?: AuthorContext;
  /**
   * `reviewer.fullFile`: the hunk's file at the PR head, whole or windowed
   * (../file-context.ts), redacted. Absent when the layer is off or there
   * is no checkout, so the prompt and the fixture key stay as they were.
   */
  readonly fullFile?: FullFileContext;
  /**
   * `reviewer.impactContext`: other code that references what the hunk
   * changes (../impact-context.ts), redacted. Absent like `fullFile`.
   */
  readonly impactContext?: ImpactContext;
  /**
   * `reviewer.requireEvidence`: the output schema requires `evidence` on
   * every finding and the system prompt gets the evidence rules. Only ever
   * `true` or absent (never `false`), for the same fixture-key reason.
   */
  readonly requireEvidence?: true;
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
  /**
   * The code that proves the claim (1–3 items asked; quote ≤ 200 chars),
   * present only on requests with `requireEvidence`. Checked against the
   * code by ../evidence-verifier.ts before the finding can be published.
   */
  readonly evidence?: readonly EvidenceItem[];
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
