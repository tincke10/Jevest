/**
 * Every label Jevest puts on a pull request, in one place.
 *
 * Names are fixed English, always `jevest: `-prefixed, and never depend on
 * `reviewer.language`: a filter, a saved search, an automation or a branch
 * rule written against a label name keeps working whatever language a repo
 * picks, and switching the language never leaves a second set of labels
 * behind. Only the description (the tooltip GitHub shows) is localized:
 * en, es and es-AR through review-language.ts, English for anything else.
 *
 * `LEGACY_LABEL_NAMES` are the names 0.1 and the pre-1.0 builds used; every
 * run removes the ones a PR still carries ({@link withLegacyLabelCleanup}),
 * so open PRs migrate on their next run.
 *
 * Not here: the spend ledger's ISSUE label (`jevest`, see
 * adapters/spend-ledger/github-issue-spend-ledger.ts), which only ever marks
 * the ledger issue and never a pull request.
 *
 * Pure: no ports, no I/O.
 */
import type { LabelDefinition, ReviewPublication } from "./ports/vcs-port.js";
import { type ReviewLanguage, resolveReviewLanguage } from "./review-language.js";

export const JEVEST_LABEL_KEYS = [
  "fix",
  "questions",
  "clear",
  "unavailable",
  "riskHigh",
  "riskMedium",
  "autoMergeOk",
  "descriptionMismatch",
  "needsProductOwner",
  "injectedInstructions",
  "spendWarning",
  "spendCapReached",
] as const;
export type JevestLabelKey = (typeof JEVEST_LABEL_KEYS)[number];

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: Readonly<Record<ReviewLanguage, string>>;
}

/** Same text for es and es-AR (no second-person form to vary). */
function spanish(text: string): { es: string; "es-AR": string } {
  return { es: text, "es-AR": text };
}

const LABELS: Readonly<Record<JevestLabelKey, LabelSpec>> = {
  fix: {
    name: "jevest: fix before merge",
    color: "b60205",
    description: {
      en: "Jev confirmed issues in the code: the author has to fix them before merging.",
      ...spanish(
        "Jev confirmó problemas en el código: el autor tiene que corregirlos antes de mergear.",
      ),
    },
  },
  questions: {
    name: "jevest: answer questions",
    color: "fbca04",
    description: {
      en: "There are doubts the author has to confirm. Not blocking on its own.",
      ...spanish("Hay dudas que el autor tiene que confirmar. No bloquea por sí solo."),
    },
  },
  clear: {
    name: "jevest: ready to approve",
    color: "0e8a16",
    description: {
      en: "Jevest found nothing to fix. The usual human approval is still needed.",
      ...spanish("Jevest no encontró nada para corregir. Falta la aprobación humana habitual."),
    },
  },
  unavailable: {
    name: "jevest: review manually",
    color: "bfbfbf",
    description: {
      en: "The automated review could not be completed: a full human review is needed.",
      ...spanish("El review automático no pudo completarse: hace falta un review humano completo."),
    },
  },
  riskHigh: {
    name: "jevest: risk high",
    color: "d93f0b",
    description: {
      en: "Jevest triage rated this PR high risk: review it carefully.",
      es: "El triage de Jevest marcó este PR como de riesgo alto: conviene revisarlo con cuidado.",
      "es-AR": "El triage de Jevest marcó este PR como de riesgo alto: revisalo con cuidado.",
    },
  },
  riskMedium: {
    name: "jevest: risk medium",
    color: "e99695",
    description: {
      en: "Jevest triage rated this PR medium risk.",
      ...spanish("El triage de Jevest marcó este PR como de riesgo medio."),
    },
  },
  autoMergeOk: {
    name: "jevest: auto-merge ok",
    color: "c2e0c6",
    description: {
      en: "Merge gate green and nothing to fix: safe to auto-merge if your workflow allows it.",
      ...spanish(
        "Merge gate en verde y nada para corregir: se puede auto-mergear si el flujo lo permite.",
      ),
    },
  },
  descriptionMismatch: {
    name: "jevest: description mismatch",
    color: "d4c5f9",
    description: {
      en: "The PR description does not match what the change does: a human should look.",
      ...spanish(
        "La descripción del PR no coincide con lo que hace el cambio: falta una mirada humana.",
      ),
    },
  },
  needsProductOwner: {
    name: "jevest: needs product owner",
    color: "5319e7",
    description: {
      en: "The change touches a product area that needs a product owner's review.",
      ...spanish(
        "El cambio toca un área de producto que necesita la revisión de un product owner.",
      ),
    },
  },
  injectedInstructions: {
    name: "jevest: injected instructions",
    color: "b60205",
    description: {
      en: "The diff has instructions addressed to a reviewer or an AI: read those hunks first.",
      es: "El diff tiene instrucciones dirigidas a un revisor o a una IA: conviene leer esos hunks primero.",
      "es-AR":
        "El diff tiene instrucciones dirigidas a un revisor o a una IA: leé esos hunks primero.",
    },
  },
  spendWarning: {
    name: "jevest: spend warning",
    color: "fef2c0",
    description: {
      en: "Jevest spend is close to the configured cap (spendCap.warnAtUsd).",
      ...spanish("El gasto de Jevest está cerca del tope configurado (spendCap.warnAtUsd)."),
    },
  },
  spendCapReached: {
    name: "jevest: spend cap reached",
    color: "e99695",
    description: {
      en: "Jevest spend cap reached: the LLM review is skipped until it resets or is raised.",
      ...spanish(
        "Se alcanzó el tope de gasto de Jevest: no hay review con LLM hasta que se reinicie o suba.",
      ),
    },
  },
};

export function labelName(key: JevestLabelKey): string {
  return LABELS[key].name;
}

/** Name and color are fixed; the description follows `reviewer.language` (en for anything but es / es-AR / es-*). */
export function labelDefinition(
  key: JevestLabelKey,
  language: string | undefined,
): LabelDefinition {
  const spec = LABELS[key];
  return {
    name: spec.name,
    color: spec.color,
    description: spec.description[resolveReviewLanguage(language)],
  };
}

/** Names earlier versions put on PRs; removed when found (see the module doc). */
export const LEGACY_LABEL_NAMES: readonly string[] = [
  // 0.1
  "jevest:needs-human",
  "jevest:auto-merge-ok",
  "jevest:description-mismatch",
  "jevest:needs-product-owner",
  "jevest:injected-instructions",
  "jevest:spend-warning",
  "jevest:spend-cap-reached",
  // Pre-1.0 builds: verdict and risk labels localized by reviewer.language.
  "jevest: corregir antes de mergear",
  "jevest: responder dudas",
  "jevest: listo para aprobar",
  "jevest: revisar a mano",
  "riesgo: alto",
  "riesgo: medio",
  "risk: high",
  "risk: medium",
];

/**
 * Adds to `labelsToRemove` every legacy label the PR carries right now
 * (`currentLabels`, from the fetched PR), so a run never spends one API
 * call per legacy name on a PR that has none. The publication comes back
 * untouched (same object) when there is nothing to clean up.
 */
export function withLegacyLabelCleanup(
  publication: ReviewPublication,
  currentLabels: readonly string[],
): ReviewPublication {
  const present = new Set(currentLabels);
  const stale = LEGACY_LABEL_NAMES.filter(
    (name) => present.has(name) && !publication.labelsToRemove.includes(name),
  );
  if (stale.length === 0) return publication;
  return { ...publication, labelsToRemove: [...publication.labelsToRemove, ...stale] };
}
