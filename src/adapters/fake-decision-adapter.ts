/**
 * Deterministic DecisionPort for stage tests (SPEC §10.2): configured with a
 * map of scripted answers per question key, or — like the fake summarizer —
 * with a function that computes the answers from the state and questions
 * (for dry runs whose question keys are the same on every request). Throws
 * on a key with no script so a test never silently gets a stub answer.
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

export type FakeDecisionScriptFn = (
  state: State,
  questions: Record<string, Question>,
) => Record<string, Decision>;

export type FakeDecisionScript = Record<string, Decision> | FakeDecisionScriptFn;

let counter = 0;

export function createFakeDecisionAdapter(script: FakeDecisionScript): DecisionPort {
  return {
    async decide<Q extends Record<string, Question>>(
      state: State,
      questions: Q,
    ): Promise<DecisionResponse<AnswersFor<Q>>> {
      const scripted = typeof script === "function" ? script(state, questions) : script;
      const answers: Record<string, Decision> = {};
      for (const key of Object.keys(questions)) {
        const decision = scripted[key];
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
