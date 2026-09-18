import { describe, expectTypeOf, it } from "vitest";
import type {
  ChoiceDecision,
  Decision,
  DecisionResponse,
  NoulDecision,
  ScoreDecision,
  Usage,
} from "./decision.js";

describe("Decision shapes", () => {
  it("noul decision is a bare probability", () => {
    const decision: NoulDecision = { type: "noul", noul: 0.87 };
    expectTypeOf(decision.noul).toBeNumber();
  });

  it("choice decision carries the pick, probabilities, and confidence", () => {
    const decision: ChoiceDecision = {
      type: "choice",
      choice: "security",
      probabilities: { security: 0.8, docs: 0.2 },
      confidence: 0.8,
    };
    expectTypeOf(decision.choice).toBeString();
    expectTypeOf(decision.probabilities).toEqualTypeOf<Record<string, number>>();
    expectTypeOf(decision.confidence).toBeNumber();
  });

  it("score decision carries score, legend, probabilities, and confidence", () => {
    const decision: ScoreDecision = {
      type: "score",
      score: 2.4,
      legend: { 0: "none", 1: "low", 2: "medium", 3: "high" },
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.6, 3: 0.2 },
      confidence: 0.6,
    };
    expectTypeOf(decision.score).toBeNumber();
    expectTypeOf(decision.legend).toEqualTypeOf<Record<number, string>>();
  });

  it("Decision is the discriminated union of the three kinds", () => {
    expectTypeOf<Decision>().toEqualTypeOf<NoulDecision | ChoiceDecision | ScoreDecision>();
  });

  it("DecisionResponse carries request metadata alongside answers", () => {
    const response: DecisionResponse<{ risk: ScoreDecision }> = {
      requestId: "req_123",
      model: "jev-latest",
      latencyMs: 42,
      usage: { inputTokens: 10, outputTokens: 0 },
      answers: {
        risk: {
          type: "score",
          score: 1,
          legend: { 0: "low", 1: "high" },
          probabilities: { 0: 0.3, 1: 0.7 },
          confidence: 0.7,
        },
      },
    };
    expectTypeOf(response.requestId).toBeString();
    expectTypeOf(response.usage).toEqualTypeOf<Usage>(response.usage);
    expectTypeOf(response.answers.risk).toEqualTypeOf<ScoreDecision>();
  });
});
