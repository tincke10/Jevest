import { describe, expect, it } from "vitest";
import {
  type ReviewVerdictInput,
  allRiskLabels,
  allVerdictLabels,
  decideReviewVerdict,
  riskLabel,
  verdictConclusion,
  verdictLabel,
  verdictLabelChanges,
  verdictLanguage,
  verdictSummary,
  verdictTitle,
} from "./review-verdict.js";

function input(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    published: 0,
    needsHuman: 0,
    llmReview: "ran",
    descriptionMismatch: false,
    injectionSuspected: false,
    secretsDetected: 0,
    ...overrides,
  };
}

describe("decideReviewVerdict", () => {
  it("is fix when at least one finding was published, and returns the counts", () => {
    expect(decideReviewVerdict(input({ published: 2, needsHuman: 1 }))).toEqual({
      verdict: "fix",
      published: 2,
      needsHuman: 1,
      questions: 1,
    });
  });

  it("is questions when nothing was published but there are needs-human doubts", () => {
    const result = decideReviewVerdict(input({ needsHuman: 3 }));
    expect(result.verdict).toBe("questions");
    expect(result.questions).toBe(3);
  });

  it("is questions when a possible secret was detected, counting one question per flagged hunk", () => {
    const result = decideReviewVerdict(input({ secretsDetected: 2, needsHuman: 1 }));
    expect(result.verdict).toBe("questions");
    expect(result.questions).toBe(3);
  });

  it("keeps fix over a detected secret, and unavailable when the review could not be trusted", () => {
    expect(decideReviewVerdict(input({ secretsDetected: 1, published: 1 })).verdict).toBe("fix");
    expect(
      decideReviewVerdict(input({ secretsDetected: 1, llmReview: "failed-entirely" })).verdict,
    ).toBe("unavailable");
  });

  it("is clear when the review ran and nothing was published or doubted", () => {
    expect(decideReviewVerdict(input()).verdict).toBe("clear");
  });

  it("is unavailable when every attempted reviewer call failed", () => {
    expect(decideReviewVerdict(input({ llmReview: "failed-entirely" })).verdict).toBe(
      "unavailable",
    );
  });

  it("is unavailable when the pipeline failed closed (NFR-2), whatever the counts say", () => {
    expect(
      decideReviewVerdict(input({ llmReview: "failed-closed", published: 3, needsHuman: 1 }))
        .verdict,
    ).toBe("unavailable");
  });

  it("is unavailable when the spend cap skipped a review the team configured", () => {
    expect(decideReviewVerdict(input({ llmReview: "skipped-for-spend-cap" })).verdict).toBe(
      "unavailable",
    );
  });

  it("is clear in Jev-only mode and on a triage skip when Jev flagged nothing (no LLM review by design)", () => {
    expect(decideReviewVerdict(input({ llmReview: "disabled" })).verdict).toBe("clear");
    expect(decideReviewVerdict(input({ llmReview: "skipped-by-triage" })).verdict).toBe("clear");
  });

  it("is unavailable when instructions to a reviewer are suspected and nothing was published", () => {
    expect(decideReviewVerdict(input({ injectionSuspected: true })).verdict).toBe("unavailable");
    expect(decideReviewVerdict(input({ injectionSuspected: true, needsHuman: 2 })).verdict).toBe(
      "unavailable",
    );
  });

  it("still blocks (fix) on published findings even when injection is suspected", () => {
    expect(decideReviewVerdict(input({ injectionSuspected: true, published: 1 })).verdict).toBe(
      "fix",
    );
  });

  it("counts an auto-band description mismatch as one question for the author", () => {
    const alone = decideReviewVerdict(input({ descriptionMismatch: true }));
    expect(alone.verdict).toBe("questions");
    expect(alone.questions).toBe(1);
    expect(alone.needsHuman).toBe(0);

    const withDoubts = decideReviewVerdict(input({ descriptionMismatch: true, needsHuman: 2 }));
    expect(withDoubts.questions).toBe(3);
    expect(
      decideReviewVerdict(input({ descriptionMismatch: true, llmReview: "skipped-by-triage" }))
        .verdict,
    ).toBe("questions");
  });

  it("partial reviewer failures do not change a count-based verdict", () => {
    expect(decideReviewVerdict(input({ llmReview: "ran" })).verdict).toBe("clear");
  });
});

describe("verdictConclusion", () => {
  it("maps fix to failure, questions and unavailable to neutral, clear to success", () => {
    expect(verdictConclusion("fix")).toBe("failure");
    expect(verdictConclusion("questions")).toBe("neutral");
    expect(verdictConclusion("unavailable")).toBe("neutral");
    expect(verdictConclusion("clear")).toBe("success");
  });
});

describe("verdictLanguage", () => {
  it("is es for Spanish tags, en by default, for English and for every other language", () => {
    expect(verdictLanguage(undefined)).toBe("en");
    expect(verdictLanguage("es")).toBe("es");
    expect(verdictLanguage("es-MX")).toBe("es");
    expect(verdictLanguage(" ES ")).toBe("es");
    expect(verdictLanguage("es-AR")).toBe("es-AR");
    expect(verdictLanguage("es_ar")).toBe("es-AR");
    expect(verdictLanguage("en")).toBe("en");
    expect(verdictLanguage("pt")).toBe("en");
  });
});

describe("verdictTitle", () => {
  const fix = (n: number) => ({
    verdict: "fix" as const,
    published: n,
    needsHuman: 0,
    questions: 0,
  });
  const questions = (n: number) => ({
    verdict: "questions" as const,
    published: 0,
    needsHuman: n,
    questions: n,
  });
  const other = (verdict: "clear" | "unavailable") => ({
    verdict,
    published: 0,
    needsHuman: 0,
    questions: 0,
  });

  it("is action-oriented and pluralized in Spanish", () => {
    expect(verdictTitle(fix(1), "es")).toBe("Corregir 1 problema antes de mergear");
    expect(verdictTitle(fix(3), "es")).toBe("Corregir 3 problemas antes de mergear");
    expect(verdictTitle(questions(1), "es")).toBe("Responder 1 duda (no bloquea)");
    expect(verdictTitle(questions(2), "es")).toBe("Responder 2 dudas (no bloquea)");
    expect(verdictTitle(other("clear"), "es")).toBe("Nada para corregir");
    expect(verdictTitle(other("unavailable"), "es")).toBe(
      "Review automático no disponible: revisar a mano",
    );
  });

  it("is action-oriented and pluralized in English, the fallback for other languages", () => {
    expect(verdictTitle(fix(1), "en")).toBe("Fix 1 issue before merging");
    expect(verdictTitle(fix(2), "en")).toBe("Fix 2 issues before merging");
    expect(verdictTitle(questions(1), "en")).toBe("Answer 1 question (not blocking)");
    expect(verdictTitle(questions(4), "fr")).toBe("Answer 4 questions (not blocking)");
    expect(verdictTitle(other("clear"), "en")).toBe("Nothing to fix");
    expect(verdictTitle(other("unavailable"), "en")).toBe(
      "Automated review unavailable: review manually",
    );
  });
});

describe("verdictSummary", () => {
  it("says who has to do what, in the verdict's language", () => {
    const fix = { verdict: "fix" as const, published: 2, needsHuman: 0, questions: 0 };
    expect(verdictSummary(fix, "es")).toMatch(/autor.*corregir 2 problemas/i);
    expect(verdictSummary(fix, "en")).toMatch(/author.*fix 2 issues/i);
    const clear = { verdict: "clear" as const, published: 0, needsHuman: 0, questions: 0 };
    expect(verdictSummary(clear, "es")).toMatch(/aprobación humana/);
    expect(verdictSummary(clear, "en")).toMatch(/human approval/);
    const unavailable = { ...clear, verdict: "unavailable" as const };
    expect(verdictSummary(unavailable, "en")).toMatch(/human.*review.*whole/i);
    const questions = { verdict: "questions" as const, published: 0, needsHuman: 1, questions: 1 };
    expect(verdictSummary(questions, "es")).toMatch(/responder 1 duda.*No bloquea/);
  });
});

describe("verdict labels", () => {
  it("names one label per verdict in fixed English, whatever the language; only the description is localized", () => {
    for (const language of ["en", "es", "es-AR", "pt"]) {
      expect(allVerdictLabels(language).map((l) => l.name)).toEqual([
        "jevest: fix before merge",
        "jevest: answer questions",
        "jevest: ready to approve",
        "jevest: review manually",
      ]);
    }
    expect(verdictLabel("fix", "es")).toEqual({
      name: "jevest: fix before merge",
      color: "b60205",
      description:
        "Jev confirmó problemas en el código: el autor tiene que corregirlos antes de mergear.",
    });
    expect(verdictLabel("fix", "en")).toEqual({
      name: "jevest: fix before merge",
      color: "b60205",
      description: "Jev confirmed issues in the code: the author has to fix them before merging.",
    });
    expect(verdictLabel("clear", "es").color).toBe("0e8a16");
    expect(verdictLabel("questions", "en").color).toBe("fbca04");
    expect(verdictLabel("unavailable", "en").color).toBe("bfbfbf");
  });

  it("lists the four verdict labels and keeps every description within GitHub's 100-char limit", () => {
    for (const language of ["es", "es-AR", "en"] as const) {
      const labels = [...allVerdictLabels(language), ...allRiskLabels(language)];
      expect(allVerdictLabels(language)).toHaveLength(4);
      for (const label of labels) {
        expect(label.description.length).toBeLessThanOrEqual(100);
        expect(label.name.length).toBeLessThanOrEqual(50);
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      }
    }
  });
});

describe("riskLabel", () => {
  it("labels high and critical as high, medium as medium, and nothing below", () => {
    expect(riskLabel("high", "es")).toMatchObject({ name: "jevest: risk high", color: "d93f0b" });
    expect(riskLabel("critical", "es")?.name).toBe("jevest: risk high");
    expect(riskLabel("medium", "es")).toMatchObject({
      name: "jevest: risk medium",
      color: "e99695",
    });
    expect(riskLabel("high", "en")?.name).toBe("jevest: risk high");
    expect(riskLabel("medium", "en")?.name).toBe("jevest: risk medium");
    expect(riskLabel("high", "es")?.description).toContain("riesgo alto");
    expect(riskLabel("high", "en")?.description).toContain("high risk");
    expect(riskLabel("low", "es")).toBeNull();
    expect(riskLabel("none", "en")).toBeNull();
    expect(allRiskLabels("en").map((l) => l.name)).toEqual([
      "jevest: risk high",
      "jevest: risk medium",
    ]);
  });
});

describe("verdictLabelChanges", () => {
  it("adds exactly one verdict label and removes the other three and the risk labels below medium", () => {
    const { add, remove } = verdictLabelChanges("questions", "low", "en");
    expect(add.map((l) => l.name)).toEqual(["jevest: answer questions"]);
    expect(remove).toEqual([
      "jevest: fix before merge",
      "jevest: ready to approve",
      "jevest: review manually",
      "jevest: risk high",
      "jevest: risk medium",
    ]);
  });

  it("adds the risk label and removes only the stale one", () => {
    const { add, remove } = verdictLabelChanges("fix", "high", "es");
    expect(add.map((l) => l.name)).toEqual(["jevest: fix before merge", "jevest: risk high"]);
    expect(remove).toContain("jevest: risk medium");
    expect(remove).not.toContain("jevest: risk high");
  });

  it("leaves risk labels untouched when the risk is unknown", () => {
    const { remove } = verdictLabelChanges("unavailable", null, "es");
    expect(remove).not.toContain("jevest: risk high");
    expect(remove).not.toContain("jevest: risk medium");
  });

  it("never adds and removes the same label", () => {
    for (const verdict of ["fix", "questions", "clear", "unavailable"] as const) {
      for (const risk of ["none", "low", "medium", "high", "critical", null] as const) {
        const { add, remove } = verdictLabelChanges(verdict, risk, "es");
        for (const label of add) expect(remove).not.toContain(label.name);
      }
    }
  });

  it("manages the same names in every language, so switching reviewer.language never duplicates labels", () => {
    const names = (language: string) => {
      const { add, remove } = verdictLabelChanges("fix", "high", language);
      return { add: add.map((l) => l.name), remove };
    };
    expect(names("es")).toEqual(names("en"));
    expect(names("es-AR")).toEqual(names("en"));
  });
});

describe("es-AR (voseo)", () => {
  it("titles use voseo imperatives where es uses infinitives", () => {
    const fix = { verdict: "fix" as const, published: 2, needsHuman: 0, questions: 0 };
    const questions = { verdict: "questions" as const, published: 0, needsHuman: 1, questions: 1 };
    const unavailable = {
      verdict: "unavailable" as const,
      published: 0,
      needsHuman: 0,
      questions: 0,
    };
    expect(verdictTitle(fix, "es")).toBe("Corregir 2 problemas antes de mergear");
    expect(verdictTitle(fix, "es-AR")).toBe("Corregí 2 problemas antes de mergear");
    expect(verdictTitle(questions, "es")).toBe("Responder 1 duda (no bloquea)");
    expect(verdictTitle(questions, "es-AR")).toBe("Respondé 1 duda (no bloquea)");
    expect(verdictTitle(unavailable, "es-AR")).toBe(
      "Review automático no disponible: revisalo a mano",
    );
    expect(verdictTitle(unavailable, "es")).toBe("Review automático no disponible: revisar a mano");
  });

  it("has no Peninsular or tú verb forms in any Spanish title or summary", () => {
    const results = [
      { verdict: "fix" as const, published: 2, needsHuman: 0, questions: 0 },
      { verdict: "questions" as const, published: 0, needsHuman: 1, questions: 1 },
      { verdict: "clear" as const, published: 0, needsHuman: 0, questions: 0 },
      { verdict: "unavailable" as const, published: 0, needsHuman: 0, questions: 0 },
    ];
    for (const lang of ["es", "es-AR"]) {
      for (const r of results) {
        expect(`${verdictTitle(r, lang)} ${verdictSummary(r, lang)}`).not.toMatch(
          /vosotros|\bvale\b|ordenador|contigo/i,
        );
      }
    }
  });

  it("keeps the label names and colors of es, and only addresses the reader with voseo in a description", () => {
    expect(allVerdictLabels("es-AR")).toEqual(allVerdictLabels("es"));
    expect(allRiskLabels("es-AR").map((l) => [l.name, l.color])).toEqual(
      allRiskLabels("es").map((l) => [l.name, l.color]),
    );
    expect(riskLabel("high", "es_AR")?.description).toContain("revisalo");
    expect(riskLabel("medium", "es_AR")).toEqual(riskLabel("medium", "es"));
  });
});
