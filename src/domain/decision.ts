/**
 * Decisions returned by a DecisionPort, one per Question kind (SPEC §1.1).
 * Zero SDK imports: an adapter maps the SDK's response shape onto these.
 */

/** Answer to a `noul` question: a bare probability of "yes", no confidence. */
export interface NoulDecision {
  readonly type: "noul";
  readonly noul: number;
}

/** Answer to a `choice` question: the pick, full distribution, and confidence. */
export interface ChoiceDecision {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

/** Answer to a `score` question: the expected score, rubric legend, distribution, and confidence. */
export interface ScoreDecision {
  readonly type: "score";
  readonly score: number;
  readonly legend: Record<number, string>;
  readonly probabilities: Record<number, number>;
  readonly confidence: number;
}

export type Decision = NoulDecision | ChoiceDecision | ScoreDecision;

/** Token usage for a decision request. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Full response from a DecisionPort call: answers keyed the same way as the
 * questions that were asked, plus request metadata for observability (SPEC FR-1.3, FR-9).
 */
export interface DecisionResponse<
  Answers extends Record<string, Decision> = Record<string, Decision>,
> {
  readonly requestId: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: Usage;
  readonly answers: Answers;
}
