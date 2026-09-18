import { describe, expect, it } from "vitest";
import type { NoulDecision, ScoreDecision } from "../domain/decision.js";
import type { NoulQuestion, ScoreQuestion } from "../domain/question.js";
import { UnscriptedQuestionError, createFakeDecisionAdapter } from "./fake-decision-adapter.js";

describe("FakeDecisionAdapter", () => {
  it("returns the scripted decision for a known question key", async () => {
    const flagDecision: NoulDecision = { type: "noul", noul: 0.9 };
    const adapter = createFakeDecisionAdapter({ flag: flagDecision });

    const response = await adapter.decide("some state", {
      flag: { type: "noul", instructions: "risky?" } satisfies NoulQuestion,
    });

    expect(response.answers.flag).toEqual(flagDecision);
  });

  it("is deterministic across repeated calls", async () => {
    const riskDecision: ScoreDecision = {
      type: "score",
      score: 2,
      legend: { 0: "low", 1: "medium", 2: "high" },
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
      confidence: 0.7,
    };
    const adapter = createFakeDecisionAdapter({ risk: riskDecision });
    const questions = {
      risk: {
        type: "score",
        instructions: "rate",
        criteria: ["low", "medium", "high"],
      } satisfies ScoreQuestion,
    };

    const first = await adapter.decide("state", questions);
    const second = await adapter.decide("state", questions);

    expect(first.answers.risk).toEqual(second.answers.risk);
    expect(first.answers.risk).toEqual(riskDecision);
  });

  it("throws UnscriptedQuestionError for a question key with no scripted answer", async () => {
    const adapter = createFakeDecisionAdapter({});

    await expect(
      adapter.decide("state", {
        flag: { type: "noul", instructions: "risky?" } satisfies NoulQuestion,
      }),
    ).rejects.toThrow(UnscriptedQuestionError);
  });

  it("fills request metadata deterministically", async () => {
    const adapter = createFakeDecisionAdapter({ flag: { type: "noul", noul: 0.1 } });
    const response = await adapter.decide("state", {
      flag: { type: "noul", instructions: "risky?" } satisfies NoulQuestion,
    });

    expect(response.requestId).toMatch(/^fake_/);
    expect(response.model).toBe("fake-decision-adapter");
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(response.latencyMs).toBe(0);
  });
});
