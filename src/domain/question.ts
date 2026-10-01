/**
 * Questions asked to a decision port (Jev's three primitives: noul, choice, score).
 * See docs/SPEC.md §1.1. Zero SDK imports: this is the domain's own vocabulary,
 * mapped to the TypeSafe SDK's question builders only inside an adapter.
 */

import type { JsonObject } from "./json.js";

/**
 * Question or criterion text: plain text, or a structured object Jev reads
 * as such — e.g. `{ question, focus, ignore }` for instructions and
 * `{ what, examples, not_for }` for an option (the SDK takes either).
 * Every question written before the agentic judge is plain text, so its
 * request (and recorded-fixture key) is unchanged.
 */
export type QuestionText = string | JsonObject;

/** A yes/no question. `noul` responses never carry `confidence` (SPEC §1.1). */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: QuestionText;
  /** Optional descriptions of the yes/no outcomes. */
  readonly criteria?: {
    readonly true?: QuestionText;
    readonly false?: QuestionText;
  };
}

/** A question that selects one of 2..255 named alternatives. */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: QuestionText;
  /** Option label -> description. Must have between 2 and 255 entries. */
  readonly criteria: Record<string, QuestionText>;
}

/** A question that assigns a score on an ordinal rubric with at least 2 levels. */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: QuestionText;
  /** Rubric level descriptions, indexed from zero. At least 2 entries. */
  readonly criteria: readonly QuestionText[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

const MIN_CHOICE_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const NOUL_CRITERIA_KEYS = new Set(["true", "false"]);

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

/**
 * Enforces the structural rules for a Question (SPEC FR-1.2):
 * - `choice`: 2..255 options
 * - `score`: at least 2 levels
 * - `noul`: criteria, if present, only describes `true` and/or `false`
 *
 * Throws {@link QuestionValidationError} on violation.
 */
export function validateQuestion(question: Question): void {
  switch (question.type) {
    case "choice": {
      const count = Object.keys(question.criteria).length;
      if (count < MIN_CHOICE_OPTIONS || count > MAX_CHOICE_OPTIONS) {
        throw new QuestionValidationError(
          `choice question must have between ${MIN_CHOICE_OPTIONS} and ${MAX_CHOICE_OPTIONS} options, got ${count}`,
        );
      }
      return;
    }
    case "score": {
      const count = question.criteria.length;
      if (count < MIN_SCORE_LEVELS) {
        throw new QuestionValidationError(
          `score question must have at least ${MIN_SCORE_LEVELS} levels, got ${count}`,
        );
      }
      return;
    }
    case "noul": {
      if (!question.criteria) {
        return;
      }
      for (const key of Object.keys(question.criteria)) {
        if (!NOUL_CRITERIA_KEYS.has(key)) {
          throw new QuestionValidationError(
            `noul criteria only accepts "true" and "false" keys, got "${key}"`,
          );
        }
      }
      return;
    }
  }
}
