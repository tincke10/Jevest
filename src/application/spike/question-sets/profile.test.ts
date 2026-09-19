import { describe, expect, it } from "vitest";
import { PROFILE_CHANGE_KINDS, profileQuestionSet } from "./profile.js";

describe("profileQuestionSet", () => {
  it("is named 'profile' with the five questions in a stable order", () => {
    expect(profileQuestionSet.name).toBe("profile");
    expect(profileQuestionSet.questions.map((q) => q.name)).toEqual([
      "change_kind",
      "touches_public_api",
      "touches_error_handling",
      "touches_async",
      "touches_io",
    ]);
  });

  it("builds change_kind as a choice with the four change kinds as criteria", () => {
    const spec = profileQuestionSet.questions.find((q) => q.name === "change_kind")!;
    const question = spec.build();
    expect(question.type).toBe("choice");
    if (question.type === "choice") {
      expect(Object.keys(question.criteria).sort()).toEqual([...PROFILE_CHANGE_KINDS].sort());
      for (const description of Object.values(question.criteria)) {
        expect(description).toBeTruthy();
        expect((description as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("builds each surface noul with explicit true/false criteria", () => {
    for (const name of [
      "touches_public_api",
      "touches_error_handling",
      "touches_async",
      "touches_io",
    ] as const) {
      const spec = profileQuestionSet.questions.find((q) => q.name === name)!;
      const question = spec.build();
      expect(question.type).toBe("noul");
      if (question.type === "noul") {
        expect(question.criteria?.true).toBeTruthy();
        expect(question.criteria?.false).toBeTruthy();
      }
    }
  });
});
