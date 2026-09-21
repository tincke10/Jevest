/**
 * Deterministic pseudo-random answers for `scripts/coherence/run.ts --mode
 * dry-run`, the coherence twin of profile/dry-run-profile-script.ts. The
 * coherence question keys are the same on every request (one pair per
 * request, keyed by question name), so a static script would answer every
 * pair identically; this one derives its RNG from the state's JSON instead,
 * and feeds the function form of the fake decision adapter. Results are
 * meaningless: they only prove the CLI, the runner and the report work end
 * to end without a TypeSafe API key.
 */
import type { FakeDecisionScriptFn } from "../../adapters/fake-decision-adapter.js";
import type { Decision } from "../../domain/decision.js";
import type { State } from "../../domain/ports/decision-port.js";
import type { Question } from "../../domain/question.js";
import { hashString, mulberry32 } from "../spike/prng.js";
import { RISK_LEVELS, type RiskLevel } from "./question-set.js";

function stateKey(state: State): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

function riskDistribution(rng: () => number): {
  choice: RiskLevel;
  probabilities: Record<string, number>;
} {
  const raw = RISK_LEVELS.map(() => rng() + 0.01);
  const sum = raw.reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  let choice: RiskLevel = RISK_LEVELS[0];
  let best = -1;
  RISK_LEVELS.forEach((level, i) => {
    const p = (raw[i] as number) / sum;
    probabilities[level] = p;
    if (p > best) {
      best = p;
      choice = level;
    }
  });
  return { choice, probabilities };
}

export function generateDryRunCoherenceScript(seed = 0): FakeDecisionScriptFn {
  return (state: State, questions: Record<string, Question>): Record<string, Decision> => {
    const rng = mulberry32((seed ^ hashString(stateKey(state))) >>> 0);
    const answers: Record<string, Decision> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const { choice, probabilities } = riskDistribution(rng);
        answers[key] = { type: "choice", choice, probabilities, confidence: 0.3 + rng() * 0.6 };
      } else {
        answers[key] = { type: "noul", noul: rng() };
      }
    }
    return answers;
  };
}
