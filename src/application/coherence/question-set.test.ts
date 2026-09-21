import { describe, expect, it } from "vitest";
import { validateQuestion } from "../../domain/question.js";
import { RISK_LEVELS, coherenceQuestionSet } from "./question-set.js";

describe("coherenceQuestionSet", () => {
  it("is named coherence and asks the five H7 questions in order", () => {
    expect(coherenceQuestionSet.name).toBe("coherence");
    expect(coherenceQuestionSet.questions.map((q) => q.name)).toEqual([
      "matches_intent",
      "user_facing",
      "breaking",
      "needs_product_owner",
      "risk_level",
    ]);
  });

  it("builds questions that all pass validateQuestion", () => {
    for (const spec of coherenceQuestionSet.questions) {
      expect(() => validateQuestion(spec.build())).not.toThrow();
    }
  });

  it("builds a fresh question object on every call", () => {
    const spec = coherenceQuestionSet.questions[0]!;
    expect(spec.build()).not.toBe(spec.build());
    expect(spec.build()).toEqual(spec.build());
  });

  it("asks matches_intent as a noul with both criteria about the description vs the change", () => {
    const question = coherenceQuestionSet.questions
      .find((q) => q.name === "matches_intent")!
      .build();
    expect(question.type).toBe("noul");
    expect(question.instructions).toMatch(/does the description describe this change/i);
    if (question.type !== "noul") throw new Error("unreachable");
    expect(question.criteria?.true).toMatch(/same files, features or behavior/i);
    expect(question.criteria?.false).toMatch(/different feature, file area or behavior/i);
  });

  it("asks user_facing, breaking and needs_product_owner as nouls", () => {
    for (const name of ["user_facing", "breaking", "needs_product_owner"]) {
      const question = coherenceQuestionSet.questions.find((q) => q.name === name)!.build();
      expect(question.type).toBe("noul");
    }
  });

  it("needs_product_owner names the non-engineer sign-off triggers", () => {
    const question = coherenceQuestionSet.questions
      .find((q) => q.name === "needs_product_owner")!
      .build();
    if (question.type !== "noul") throw new Error("unreachable");
    const text = `${question.instructions} ${question.criteria?.true ?? ""}`.toLowerCase();
    for (const trigger of ["user-visible", "pricing", "permissions", "data retention"]) {
      expect(text).toContain(trigger);
    }
  });

  it("asks risk_level as a choice over none/low/medium/high/critical", () => {
    const question = coherenceQuestionSet.questions.find((q) => q.name === "risk_level")!.build();
    expect(question.type).toBe("choice");
    if (question.type !== "choice") throw new Error("unreachable");
    expect(RISK_LEVELS).toEqual(["none", "low", "medium", "high", "critical"]);
    expect(Object.keys(question.criteria)).toEqual([...RISK_LEVELS]);
  });

  it("never asks Jev to count, compute or read code (NFR-5): no numbers in any question text", () => {
    for (const spec of coherenceQuestionSet.questions) {
      const question = spec.build();
      const texts = [question.instructions, ...Object.values(question.criteria ?? {})];
      for (const text of texts) {
        expect(text).not.toMatch(/\d/);
      }
    }
  });
});
