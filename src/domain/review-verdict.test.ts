import { describe, expect, it } from "vitest";
import {
  LEGACY_NEEDS_HUMAN_LABEL,
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
  it("is es for Spanish tags and by default, en for English and every other language", () => {
    expect(verdictLanguage(undefined)).toBe("es");
    expect(verdictLanguage("es")).toBe("es");
    expect(verdictLanguage("es-AR")).toBe("es");
    expect(verdictLanguage(" ES ")).toBe("es");
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
  it("names, colors and describes one label per verdict, per language", () => {
    expect(verdictLabel("fix", "es")).toEqual({
      name: "jevest: corregir antes de mergear",
      color: "b60205",
      description:
        "Jev confirmó problemas en el código: el autor tiene que corregirlos antes de mergear.",
    });
    expect(verdictLabel("questions", "es")).toEqual({
      name: "jevest: responder dudas",
      color: "fbca04",
      description: "Hay dudas que el autor tiene que confirmar. No bloquea por sí solo.",
    });
    expect(verdictLabel("clear", "es")).toEqual({
      name: "jevest: listo para aprobar",
      color: "0e8a16",
      description: "Jevest no encontró nada para corregir. Falta la aprobación humana habitual.",
    });
    expect(verdictLabel("unavailable", "es")).toEqual({
      name: "jevest: revisar a mano",
      color: "bfbfbf",
      description:
        "El review automático no pudo completarse: hace falta un review humano completo.",
    });
    expect(verdictLabel("fix", "en").name).toBe("jevest: fix before merge");
    expect(verdictLabel("questions", "en").name).toBe("jevest: answer questions");
    expect(verdictLabel("clear", "en").name).toBe("jevest: ready to approve");
    expect(verdictLabel("unavailable", "en").name).toBe("jevest: review manually");
    expect(verdictLabel("fix", "en").color).toBe("b60205");
  });

  it("lists the four verdict labels and keeps every description within GitHub's 100-char limit", () => {
    for (const language of ["es", "en"] as const) {
      const labels = [...allVerdictLabels(language), ...allRiskLabels(language)];
      expect(allVerdictLabels(language)).toHaveLength(4);
      for (const label of labels) {
        expect(label.description.length).toBeLessThanOrEqual(100);
        expect(label.name.length).toBeLessThanOrEqual(50);
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      }
    }
  });

  it("keeps the legacy label name for migration", () => {
    expect(LEGACY_NEEDS_HUMAN_LABEL).toBe("jevest:needs-human");
  });
});

describe("riskLabel", () => {
  it("labels high and critical as high, medium as medium, and nothing below", () => {
    expect(riskLabel("high", "es")).toMatchObject({ name: "riesgo: alto", color: "d93f0b" });
    expect(riskLabel("critical", "es")?.name).toBe("riesgo: alto");
    expect(riskLabel("medium", "es")).toMatchObject({ name: "riesgo: medio", color: "e99695" });
    expect(riskLabel("high", "en")?.name).toBe("risk: high");
    expect(riskLabel("medium", "en")?.name).toBe("risk: medium");
    expect(riskLabel("low", "es")).toBeNull();
    expect(riskLabel("none", "en")).toBeNull();
    expect(allRiskLabels("en").map((l) => l.name)).toEqual(["risk: high", "risk: medium"]);
  });
});

describe("verdictLabelChanges", () => {
  it("adds exactly one verdict label, removes the other three and the legacy label", () => {
    const { add, remove } = verdictLabelChanges("questions", "low", "en");
    expect(add.map((l) => l.name)).toEqual(["jevest: answer questions"]);
    expect(remove).toEqual(
      expect.arrayContaining([
        "jevest: fix before merge",
        "jevest: ready to approve",
        "jevest: review manually",
        "jevest:needs-human",
        "risk: high",
        "risk: medium",
      ]),
    );
    expect(remove).not.toContain("jevest: answer questions");
  });

  it("adds the risk label and removes only the stale one", () => {
    const { add, remove } = verdictLabelChanges("fix", "high", "es");
    expect(add.map((l) => l.name)).toEqual(["jevest: corregir antes de mergear", "riesgo: alto"]);
    expect(remove).toContain("riesgo: medio");
    expect(remove).not.toContain("riesgo: alto");
  });

  it("leaves risk labels untouched when the risk is unknown", () => {
    const { remove } = verdictLabelChanges("unavailable", null, "es");
    expect(remove).not.toContain("riesgo: alto");
    expect(remove).not.toContain("riesgo: medio");
  });

  it("never adds and removes the same label", () => {
    for (const verdict of ["fix", "questions", "clear", "unavailable"] as const) {
      for (const risk of ["none", "low", "medium", "high", "critical", null] as const) {
        const { add, remove } = verdictLabelChanges(verdict, risk, "es");
        for (const label of add) expect(remove).not.toContain(label.name);
      }
    }
  });
});
