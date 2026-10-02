import { describe, expect, it } from "vitest";
import {
  isSpanish,
  primaryLanguage,
  resolveReviewLanguage,
  spanishStyleRule,
} from "./review-language.js";

describe("resolveReviewLanguage", () => {
  it("defaults to en, like reviewer.language", () => {
    expect(resolveReviewLanguage(undefined)).toBe("en");
  });

  it.each(["es-AR", "es-ar", "ES-AR", "es_AR", " es_ar "])("accepts %s as es-AR", (tag) => {
    expect(resolveReviewLanguage(tag)).toBe("es-AR");
  });

  it.each(["es", "ES", "es-MX", "es_CO", "es-ES"])("falls back %s to es", (tag) => {
    expect(resolveReviewLanguage(tag)).toBe("es");
  });

  it.each(["en", "pt-BR", "fr", "Spanish", ""])("resolves %s to en", (tag) => {
    expect(resolveReviewLanguage(tag)).toBe("en");
  });
});

describe("isSpanish / primaryLanguage", () => {
  it("is true for both Spanish variants only", () => {
    expect(isSpanish("es")).toBe(true);
    expect(isSpanish("es-AR")).toBe(true);
    expect(isSpanish("en")).toBe(false);
  });

  it("returns the lowercase primary subtag", () => {
    expect(primaryLanguage("es_AR")).toBe("es");
    expect(primaryLanguage(undefined)).toBe("");
  });
});

describe("spanishStyleRule", () => {
  it("es is neutral Latin American: no vosotros, no Peninsular, no voseo", () => {
    const rule = spanishStyleRule("es") ?? "";
    expect(rule).toContain("neutral Latin American Spanish");
    expect(rule).toContain("vosotros");
    expect(rule).toContain("Peninsular");
    expect(rule).not.toContain("Rioplatense");
  });

  it("es-AR demands voseo", () => {
    const rule = spanishStyleRule("es-AR") ?? "";
    expect(rule).toContain("Rioplatense");
    for (const form of ["revisá", "fijate", "tenés", "podés"]) {
      expect(rule).toContain(form);
    }
  });

  it("is null for other languages", () => {
    expect(spanishStyleRule("en")).toBeNull();
  });
});
