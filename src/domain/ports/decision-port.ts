/**
 * Port for asking Jev-shaped questions about a piece of state (SPEC FR-1).
 * Zero SDK imports: adapters (fake, recorded, TypeSafe) implement this.
 */
import type {
  ChoiceDecision,
  Decision,
  DecisionResponse,
  NoulDecision,
  ScoreDecision,
} from "../decision.js";
import type { JsonArray, JsonObject } from "../json.js";
import type { ChoiceQuestion, NoulQuestion, Question, ScoreQuestion } from "../question.js";

/** The state a decision is made about: text or structured JSON (SPEC §8 FR-1). */
export type State = string | JsonObject | JsonArray;

/** Maps a Question to the Decision type its answer will have. */
export type DecisionFor<Q extends Question> = Q extends NoulQuestion
  ? NoulDecision
  : Q extends ChoiceQuestion
    ? ChoiceDecision
    : Q extends ScoreQuestion
      ? ScoreDecision
      : never;

/** Answers keyed the same way as the questions that were asked, typed per question. */
export type AnswersFor<Q extends Record<string, Question>> = {
  [K in keyof Q]: DecisionFor<Q[K]>;
};

export interface DecisionPort {
  /**
   * Answers a fan-out of named questions about one piece of state in a single
   * call (SPEC FR-1.1, FR-1.4). The response type is inferred per question key.
   */
  decide<Q extends Record<string, Question>>(
    state: State,
    questions: Q,
  ): Promise<DecisionResponse<AnswersFor<Q>>>;
}

// Re-exported so adapters can implement DecisionPort without importing from ../decision.js directly.
export type { Decision };
