import { describe, expect, it } from "vitest";
import { DEFECT_LIKELIHOOD_LEVELS, defectQuestionSet } from "./defect.js";

describe("defectQuestionSet", () => {
  it("is named 'defect' with the three questions in a stable order", () => {
    expect(defectQuestionSet.name).toBe("defect");
    expect(defectQuestionSet.questions.map((q) => q.name)).toEqual([
      "defect_likelihood",
      "touches_public_api",
      "touches_security",
    ]);
  });

  it("builds defect_likelihood as a 4-level score with a description per level", () => {
    const spec = defectQuestionSet.questions.find((q) => q.name === "defect_likelihood")!;
    const question = spec.build();
    expect(question.type).toBe("score");
    if (question.type === "score") {
      expect(question.criteria).toHaveLength(DEFECT_LIKELIHOOD_LEVELS.length);
      for (const description of question.criteria) {
        expect(description.length).toBeGreaterThan(0);
      }
    }
  });

  it("builds touches_public_api as a noul with true/false criteria", () => {
    const spec = defectQuestionSet.questions.find((q) => q.name === "touches_public_api")!;
    const question = spec.build();
    expect(question.type).toBe("noul");
    if (question.type === "noul") {
      expect(question.criteria?.true).toBeTruthy();
      expect(question.criteria?.false).toBeTruthy();
    }
  });

  it("builds touches_security as a noul with true/false criteria", () => {
    const spec = defectQuestionSet.questions.find((q) => q.name === "touches_security")!;
    const question = spec.build();
    expect(question.type).toBe("noul");
    if (question.type === "noul") {
      expect(question.criteria?.true).toBeTruthy();
      expect(question.criteria?.false).toBeTruthy();
    }
  });
});
