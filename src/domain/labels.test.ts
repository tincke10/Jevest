import { describe, expect, it } from "vitest";
import {
  JEVEST_LABEL_KEYS,
  LEGACY_LABEL_NAMES,
  labelDefinition,
  labelName,
  withLegacyLabelCleanup,
} from "./labels.js";
import type { ReviewPublication } from "./ports/vcs-port.js";

describe("Jevest label names", () => {
  it("are fixed English names, always prefixed with `jevest: `", () => {
    expect(JEVEST_LABEL_KEYS.map(labelName)).toEqual([
      "jevest: fix before merge",
      "jevest: answer questions",
      "jevest: ready to approve",
      "jevest: review manually",
      "jevest: risk high",
      "jevest: risk medium",
      "jevest: auto-merge ok",
      "jevest: description mismatch",
      "jevest: needs product owner",
      "jevest: injected instructions",
      "jevest: spend warning",
      "jevest: spend cap reached",
    ]);
  });

  it("never depend on reviewer.language: only the description is localized", () => {
    for (const key of JEVEST_LABEL_KEYS) {
      const en = labelDefinition(key, "en");
      const es = labelDefinition(key, "es");
      const ar = labelDefinition(key, "es-AR");
      const other = labelDefinition(key, "pt-BR");
      expect(new Set([en.name, es.name, ar.name, other.name]).size).toBe(1);
      expect(new Set([en.color, es.color, ar.color]).size).toBe(1);
      expect(es.description).not.toBe(en.description);
      expect(other.description).toBe(en.description);
    }
  });

  it("uses voseo in the es-AR descriptions that address the reader, and never in es", () => {
    expect(labelDefinition("riskHigh", "es-AR").description).toContain("revisalo");
    expect(labelDefinition("riskHigh", "es").description).not.toContain("revisalo");
    expect(labelDefinition("injectedInstructions", "es-AR").description).toContain("leé");
    expect(labelDefinition("injectedInstructions", "es").description).not.toContain("leé");
  });

  it("fits GitHub's limits: a 6-digit hex color and a description of at most 100 characters", () => {
    for (const key of JEVEST_LABEL_KEYS) {
      for (const language of ["en", "es", "es-AR"]) {
        const { color, description } = labelDefinition(key, language);
        expect(color).toMatch(/^[0-9a-f]{6}$/);
        expect(description.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("legacy (0.1 and pre-1.0) label names", () => {
  it("lists every name an earlier version could have put on a PR", () => {
    expect([...LEGACY_LABEL_NAMES].sort()).toEqual(
      [
        "jevest:needs-human",
        "jevest:auto-merge-ok",
        "jevest:description-mismatch",
        "jevest:needs-product-owner",
        "jevest:injected-instructions",
        "jevest:spend-warning",
        "jevest:spend-cap-reached",
        "jevest: corregir antes de mergear",
        "jevest: responder dudas",
        "jevest: listo para aprobar",
        "jevest: revisar a mano",
        "riesgo: alto",
        "riesgo: medio",
        "risk: high",
        "risk: medium",
      ].sort(),
    );
  });

  it("never clashes with a current name", () => {
    const current = new Set(JEVEST_LABEL_KEYS.map(labelName));
    for (const legacy of LEGACY_LABEL_NAMES) expect(current.has(legacy)).toBe(false);
  });
});

describe("withLegacyLabelCleanup", () => {
  const publication: ReviewPublication = {
    summaryMarkdown: "s",
    summaryFingerprint: "f",
    inlineComments: [],
    labelsToAdd: ["jevest: ready to approve"],
    labelsToRemove: ["jevest: fix before merge"],
    check: { conclusion: "success", title: "t", summary: "s" },
  };

  it("removes the legacy labels the PR carries, and only those", () => {
    const cleaned = withLegacyLabelCleanup(publication, [
      "jevest:needs-human",
      "riesgo: alto",
      "bug",
      "jevest: ready to approve",
    ]);
    expect(cleaned.labelsToRemove).toEqual([
      "jevest: fix before merge",
      "jevest:needs-human",
      "riesgo: alto",
    ]);
    expect(cleaned.labelsToAdd).toEqual(publication.labelsToAdd);
  });

  it("returns the publication unchanged when the PR has no legacy label", () => {
    expect(withLegacyLabelCleanup(publication, ["bug"])).toBe(publication);
  });

  it("does not list a legacy name twice", () => {
    const already = { ...publication, labelsToRemove: ["risk: high"] };
    expect(withLegacyLabelCleanup(already, ["risk: high"]).labelsToRemove).toEqual(["risk: high"]);
  });
});
