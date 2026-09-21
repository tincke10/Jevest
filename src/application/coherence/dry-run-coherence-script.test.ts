import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../domain/json.js";
import { generateDryRunCoherenceScript } from "./dry-run-coherence-script.js";
import { RISK_LEVELS, coherenceQuestionSet } from "./question-set.js";

const QUESTIONS = Object.fromEntries(
  coherenceQuestionSet.questions.map((q) => [q.name, q.build()]),
);

function state(title: string): JsonObject {
  return { intent: { title }, change_facts: { size: "small" } };
}

describe("generateDryRunCoherenceScript", () => {
  it("answers every coherence question with valid decisions", () => {
    const script = generateDryRunCoherenceScript(1);
    const answers = script(state("a"), QUESTIONS);

    expect(Object.keys(answers).sort()).toEqual(
      ["breaking", "matches_intent", "needs_product_owner", "risk_level", "user_facing"].sort(),
    );
    for (const key of ["matches_intent", "user_facing", "breaking", "needs_product_owner"]) {
      const d = answers[key]!;
      expect(d.type).toBe("noul");
      if (d.type === "noul") {
        expect(d.noul).toBeGreaterThanOrEqual(0);
        expect(d.noul).toBeLessThanOrEqual(1);
      }
    }
    const risk = answers.risk_level!;
    expect(risk.type).toBe("choice");
    if (risk.type === "choice") {
      expect(RISK_LEVELS).toContain(risk.choice);
      const sum = Object.values(risk.probabilities).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(risk.probabilities[risk.choice]).toBe(Math.max(...Object.values(risk.probabilities)));
    }
  });

  it("is deterministic per state and seed, and varies across states", () => {
    const script = generateDryRunCoherenceScript(42);
    const a1 = script(state("a"), QUESTIONS);
    const a2 = script(state("a"), QUESTIONS);
    const b = script(state("b"), QUESTIONS);

    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(generateDryRunCoherenceScript(43)(state("a"), QUESTIONS)).not.toEqual(a1);
  });
});
