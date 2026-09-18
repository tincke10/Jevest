import { describe, expect, it } from "vitest";
import {
  type ChoiceQuestion,
  type NoulQuestion,
  QuestionValidationError,
  type ScoreQuestion,
  validateQuestion,
} from "./question.js";

function choiceWithOptions(count: number): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    criteria[`option_${i}`] = `Description of option ${i}`;
  }
  return { type: "choice", instructions: "Pick one", criteria };
}

function scoreWithLevels(count: number): ScoreQuestion {
  return {
    type: "score",
    instructions: "Rate it",
    criteria: Array.from({ length: count }, (_, i) => `Level ${i}`),
  };
}

describe("validateQuestion", () => {
  describe("choice", () => {
    it("rejects a choice question with fewer than 2 options", () => {
      expect(() => validateQuestion(choiceWithOptions(1))).toThrow(QuestionValidationError);
    });

    it("rejects a choice question with 0 options", () => {
      expect(() => validateQuestion(choiceWithOptions(0))).toThrow(QuestionValidationError);
    });

    it("accepts a choice question with exactly 2 options", () => {
      expect(() => validateQuestion(choiceWithOptions(2))).not.toThrow();
    });

    it("accepts a choice question with exactly 255 options", () => {
      expect(() => validateQuestion(choiceWithOptions(255))).not.toThrow();
    });

    it("rejects a choice question with 256 options", () => {
      expect(() => validateQuestion(choiceWithOptions(256))).toThrow(QuestionValidationError);
    });
  });

  describe("score", () => {
    it("rejects a score question with fewer than 2 levels", () => {
      expect(() => validateQuestion(scoreWithLevels(1))).toThrow(QuestionValidationError);
    });

    it("rejects a score question with 0 levels", () => {
      expect(() => validateQuestion(scoreWithLevels(0))).toThrow(QuestionValidationError);
    });

    it("accepts a score question with exactly 2 levels", () => {
      expect(() => validateQuestion(scoreWithLevels(2))).not.toThrow();
    });

    it("accepts a score question with many levels", () => {
      expect(() => validateQuestion(scoreWithLevels(10))).not.toThrow();
    });
  });

  describe("noul", () => {
    it("accepts a noul question without criteria", () => {
      const question: NoulQuestion = { type: "noul", instructions: "Is this billing?" };
      expect(() => validateQuestion(question)).not.toThrow();
    });

    it("accepts a noul question with true/false criteria", () => {
      const question: NoulQuestion = {
        type: "noul",
        instructions: "Is this billing?",
        criteria: { true: "It mentions a charge", false: "It does not mention a charge" },
      };
      expect(() => validateQuestion(question)).not.toThrow();
    });

    it("accepts a noul question with only a true criterion", () => {
      const question: NoulQuestion = {
        type: "noul",
        instructions: "Is this billing?",
        criteria: { true: "It mentions a charge" },
      };
      expect(() => validateQuestion(question)).not.toThrow();
    });

    it("rejects a noul question with an unknown criteria key", () => {
      const question = {
        type: "noul",
        instructions: "Is this billing?",
        criteria: { maybe: "unsure" },
      } as unknown as NoulQuestion;
      expect(() => validateQuestion(question)).toThrow(QuestionValidationError);
    });
  });
});
