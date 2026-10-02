/**
 * `reviewer.language` resolution, shared by every localized string and every
 * LLM prompt that writes user-facing text.
 *
 * Variants: `en` (the default, like `reviewer.language`), `es` (neutral
 * Latin American Spanish) and `es-AR` (Rioplatense Spanish with voseo). Matching is case-insensitive and
 * accepts `-` or `_` (`es-ar`, `es_AR`); any other `es-*` falls back to `es`;
 * anything else is `en` for the static strings (the narrator still writes in
 * whatever language was asked, the model understands it).
 *
 * Pure: no ports, no I/O.
 */

export type ReviewLanguage = "es" | "es-AR" | "en";

export function resolveReviewLanguage(language: string | undefined): ReviewLanguage {
  if (language === undefined) return "en";
  const [primary = "", region = ""] = language.trim().toLowerCase().split(/[-_]/);
  if (primary !== "es") return "en";
  return region === "ar" ? "es-AR" : "es";
}

/** True for `es` and `es-AR`: both share most Spanish strings. */
export function isSpanish(language: string | undefined): boolean {
  return resolveReviewLanguage(language) !== "en";
}

/** Primary subtag of a language tag ("es-AR" is "es"), lowercase. */
export function primaryLanguage(language: string | undefined): string {
  return (language ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

const NEUTRAL_SPANISH_RULE =
  'Spanish style: neutral Latin American Spanish. Prefer impersonal phrasing ("conviene revisar", "hay que"); "tú" forms are acceptable. Never use "vosotros" or its verb forms, never Peninsular-only wording ("vale", "ordenador", "coger", "contigo" when avoidable) and never voseo.';

const RIOPLATENSE_SPANISH_RULE =
  'Spanish style: Rioplatense Spanish (Argentina/Uruguay) with voseo: "revisá", "fijate", "tenés", "podés", "mirá". Never use "vosotros", "tú" verb forms ("revisa", "tienes", "puedes") or Peninsular-only wording ("vale", "ordenador", "contigo").';

/** The style rule appended to user-facing prompts for the Spanish variants; null for every other language. */
export function spanishStyleRule(language: string | undefined): string | null {
  switch (resolveReviewLanguage(language)) {
    case "es":
      return NEUTRAL_SPANISH_RULE;
    case "es-AR":
      return RIOPLATENSE_SPANISH_RULE;
    case "en":
      return null;
  }
}
