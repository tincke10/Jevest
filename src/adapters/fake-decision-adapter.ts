/**
 * Deterministic DecisionPort for stage tests (SPEC §10.2): configured with a
 * map of scripted answers per question key; throws on a key with no script.
 */
import type { Decision, DecisionResponse } from "../domain/decision.js";
import type { AnswersFor, DecisionPort, State } from "../domain/ports/decision-port.js";
import type { Question } from "../domain/question.js";

export class UnscriptedQuestionError extends Error {
  constructor(key: string) {
    super(`no scripted decision for question key "${key}"`);
    this.name = "UnscriptedQuestionError";
  }
}

let counter = 0;

export function createFakeDecisionAdapter(script: Record<string, Decision>): DecisionPort {
  return {
    async decide<Q extends Record<string, Question>>(
      _state: State,
      questions: Q,
    ): Promise<DecisionResponse<AnswersFor<Q>>> {
      const answers: Record<string, Decision> = {};
      for (const key of Object.keys(questions)) {
        const decision = script[key];
        if (!decision) {
          throw new UnscriptedQuestionError(key);
        }
        answers[key] = decision;
      }

      counter += 1;

      return {
        requestId: `fake_${counter}`,
        model: "fake-decision-adapter",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        answers: answers as AnswersFor<Q>,
      };
    },
  };
}
