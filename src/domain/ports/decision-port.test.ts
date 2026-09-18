import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChoiceDecision, NoulDecision, ScoreDecision } from "../decision.js";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../question.js";
import type { DecisionPort, State } from "./decision-port.js";

/** Minimal fake satisfying the DecisionPort contract, for type + shape checks. */
function makeFakePort(): DecisionPort {
  return {
    async decide(_state, questions) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          answers[key] = { type: "noul", noul: 0.5 } satisfies NoulDecision;
        } else if (question.type === "choice") {
          const [firstLabel] = Object.keys(question.criteria);
          answers[key] = {
            type: "choice",
            choice: firstLabel!,
            probabilities: { [firstLabel!]: 1 },
            confidence: 1,
          } satisfies ChoiceDecision;
        } else {
          answers[key] = {
            type: "score",
            score: 0,
            legend: { 0: question.criteria[0]! },
            probabilities: { 0: 1 },
            confidence: 1,
          } satisfies ScoreDecision;
        }
      }
      return {
        requestId: "req_fake",
        model: "fake-model",
        latencyMs: 1,
        answers: answers as never,
        usage: { inputTokens: 1, outputTokens: 0 },
      };
    },
  };
}

describe("DecisionPort", () => {
  it("infers a NoulDecision for a noul question and a ScoreDecision for a score question", async () => {
    const port = makeFakePort();
    const questions = {
      flag: { type: "noul", instructions: "Is this risky?" } satisfies NoulQuestion,
      risk: {
        type: "score",
        instructions: "Rate the risk",
        criteria: ["low", "high"],
      } satisfies ScoreQuestion,
    };

    const response = await port.decide("some state", questions);

    expectTypeOf(response.answers.flag).toEqualTypeOf<NoulDecision>(response.answers.flag);
    expectTypeOf(response.answers.risk).toEqualTypeOf<ScoreDecision>(response.answers.risk);
    expect(response.answers.flag.noul).toBe(0.5);
    expect(response.answers.risk.score).toBe(0);
    expect(response.requestId).toBe("req_fake");
  });

  it("infers a ChoiceDecision for a choice question", async () => {
    const port = makeFakePort();
    const questions = {
      category: {
        type: "choice",
        instructions: "Pick a category",
        criteria: { docs: "Documentation only", security: "Touches security" },
      } satisfies ChoiceQuestion,
    };

    const response = await port.decide("some state", questions);

    expectTypeOf(response.answers.category).toEqualTypeOf<ChoiceDecision>(
      response.answers.category,
    );
    expect(response.answers.category.choice).toBe("docs");
  });

  it("accepts a JSON object as state", async () => {
    const port = makeFakePort();
    const state: State = { title: "fix bug", additions: 1 };
    const questions = { flag: { type: "noul", instructions: "ok?" } satisfies NoulQuestion };

    const response = await port.decide(state, questions);
    expect(response.answers.flag.type).toBe("noul");
  });

  it("accepts a JSON array as state", async () => {
    const port = makeFakePort();
    const state: State = [{ file: "a.ts" }, { file: "b.ts" }];
    const questions = { flag: { type: "noul", instructions: "ok?" } satisfies NoulQuestion };

    const response = await port.decide(state, questions);
    expect(response.answers.flag.type).toBe("noul");
  });
});
