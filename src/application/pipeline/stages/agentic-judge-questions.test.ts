import { describe, expect, it } from "vitest";
import { AGENTIC_CATEGORIES } from "../../../domain/agentic-finding.js";
import { validateQuestion } from "../../../domain/question.js";
import {
  AGENTIC_MECHANISMS,
  AGENTIC_SEVERITY_RUBRIC,
  mechanismQuestion,
  severityQuestion,
  supportsQuestion,
} from "./agentic-judge-questions.js";

describe("agentic judge questions", () => {
  it("supports: a structured choice of proves / partially / noMatch with explicit boundaries", () => {
    const q = supportsQuestion();
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["proves", "partially", "noMatch"]);
    expect(q.instructions).toMatchObject({
      question: expect.stringContaining("selectedEvidence"),
      focus: expect.any(String),
      ignore: expect.any(Array),
    });
    for (const option of Object.values(q.criteria)) {
      expect(option).toMatchObject({ what: expect.any(String), examples: expect.any(Array) });
    }
    expect(q.criteria.proves).toHaveProperty("not_for");
    validateQuestion(q);
  });

  it("mechanism: one vocabulary per category, each with an escape hatch noIssue", () => {
    for (const category of AGENTIC_CATEGORIES) {
      const q = mechanismQuestion(category);
      expect(q.type).toBe("choice");
      expect(Object.keys(q.criteria)).toEqual(Object.keys(AGENTIC_MECHANISMS[category]));
      expect(Object.keys(q.criteria)).toContain("noIssue");
      expect(Object.keys(q.criteria)).toContain("other");
      validateQuestion(q);
    }
    expect(Object.keys(AGENTIC_MECHANISMS.correctness)).toEqual([
      "condition",
      "state",
      "dataFlow",
      "asyncControl",
      "other",
      "noIssue",
    ]);
    expect(Object.keys(AGENTIC_MECHANISMS.regression)).toEqual([
      "api",
      "behavior",
      "dataFormat",
      "protocol",
      "other",
      "noIssue",
    ]);
  });

  it("severity: a 0-3 rubric from no impact to critical", () => {
    const q = severityQuestion();
    expect(q.type).toBe("score");
    expect(q.criteria).toHaveLength(4);
    expect(AGENTIC_SEVERITY_RUBRIC[0]).toMatchObject({
      what: expect.stringMatching(/no meaningful impact/i),
    });
    expect(AGENTIC_SEVERITY_RUBRIC[3]).toMatchObject({ what: expect.stringMatching(/critical/i) });
    validateQuestion(q);
  });
});
