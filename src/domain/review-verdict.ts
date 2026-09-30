/**
 * The review verdict: ONE action per run that says what has to happen
 * next, and whether it blocks. It drives the `jevest` check conclusion,
 * the check title and summary, the verdict label and the narrative's
 * closing line, so the PR list, the check and the comment can never
 * disagree ("no issues" ending with "needs changes").
 *
 * - `fix`: at least one PUBLISHED finding (high confidence, confirmed by
 *   Jev). The author must fix it. Blocks: check `failure`.
 * - `questions`: nothing published, but doubts (needs-human findings) or an
 *   auto-band description mismatch for the author to answer. `neutral`.
 * - `clear`: nothing to fix or answer. `success`; the usual human approval
 *   is still needed. Whether the PR may auto-merge is the merge gate's
 *   separate call (`jevest:auto-merge-ok`), not this verdict's.
 * - `unavailable`: the automated review could not be done or cannot be
 *   trusted, so a human reviews the whole PR. `neutral`.
 *
 * Judgment calls (see the tests):
 * - No LLM review BY DESIGN (Jev-only mode, `reviewer.provider: none`, or
 *   triage's FR-2.3 low-risk skip) is `clear` when Jev's own stages flagged
 *   nothing: the team chose that depth of review, and "unavailable" on
 *   every Jev-only PR would be noise that says nothing.
 * - A spend cap that skipped a review the team configured is `unavailable`:
 *   the review they asked for did not happen.
 * - Suspected instructions to a reviewer (in the description or the diff)
 *   are `unavailable` unless something was published: the LLM review may
 *   have been steered, so "nothing to fix" would not be honest. Published
 *   findings still block.
 * - The NFR-2 fail-closed exit is `unavailable`, but its check stays
 *   `failure` (see publish.ts `buildFailClosedPublication`).
 *
 * Pure: no ports, no I/O. Text is es/en; any other `reviewer.language`
 * falls back to English.
 */
import type { LabelDefinition } from "./ports/vcs-port.js";

export type ReviewVerdict = "fix" | "questions" | "clear" | "unavailable";

/** What happened to the LLM review on this run. */
export type LlmReviewOutcome =
  /** The review stage ran; some calls may have failed, not all. */
  | "ran"
  /** `reviewer.provider: none` (Jev-only mode). */
  | "disabled"
  /** Triage FR-2.3: low risk, high confidence; the review was never needed. */
  | "skipped-by-triage"
  /** The cumulative spend cap was reached before the run (NFR-10). */
  | "skipped-for-spend-cap"
  /** The reviewer was called and threw on every call. */
  | "failed-entirely"
  /** The pipeline stopped on a Jev failure (NFR-2). */
  | "failed-closed";

export interface ReviewVerdictInput {
  /** Findings published (the auto band). */
  readonly published: number;
  /** Findings in the needs-human queue (doubts). */
  readonly needsHuman: number;
  readonly llmReview: LlmReviewOutcome;
  /** An auto-band description-vs-change mismatch: one more question for the author. */
  readonly descriptionMismatch: boolean;
  /** Instructions to a reviewer suspected in the description or the diff (NFR-7). */
  readonly injectionSuspected: boolean;
}

export interface ReviewVerdictResult {
  readonly verdict: ReviewVerdict;
  readonly published: number;
  readonly needsHuman: number;
  /** What the author has to answer: the doubts plus one for a description mismatch. */
  readonly questions: number;
}

export function decideReviewVerdict(input: ReviewVerdictInput): ReviewVerdictResult {
  const questions = input.needsHuman + (input.descriptionMismatch ? 1 : 0);
  const counts = { published: input.published, needsHuman: input.needsHuman, questions };
  const verdict = ((): ReviewVerdict => {
    if (input.llmReview === "failed-closed") return "unavailable";
    if (input.published > 0) return "fix";
    if (input.llmReview === "failed-entirely" || input.llmReview === "skipped-for-spend-cap") {
      return "unavailable";
    }
    if (input.injectionSuspected) return "unavailable";
    if (questions > 0) return "questions";
    return "clear";
  })();
  return { verdict, ...counts };
}

export function verdictConclusion(verdict: ReviewVerdict): "success" | "neutral" | "failure" {
  switch (verdict) {
    case "fix":
      return "failure";
    case "clear":
      return "success";
    case "questions":
    case "unavailable":
      return "neutral";
  }
}

export type VerdictLanguage = "es" | "en";

/** `reviewer.language` to the verdict text's language: es by default (the config's default), en for everything else. */
export function verdictLanguage(language: string | undefined): VerdictLanguage {
  if (language === undefined) return "es";
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return primary === "es" ? "es" : "en";
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The check title and the narrative's verdict line. */
export function verdictTitle(result: ReviewVerdictResult, language: string | undefined): string {
  const es = verdictLanguage(language) === "es";
  switch (result.verdict) {
    case "fix":
      return es
        ? `Corregir ${count(result.published, "problema", "problemas")} antes de mergear`
        : `Fix ${count(result.published, "issue", "issues")} before merging`;
    case "questions":
      return es
        ? `Responder ${count(result.questions, "duda", "dudas")} (no bloquea)`
        : `Answer ${count(result.questions, "question", "questions")} (not blocking)`;
    case "clear":
      return es ? "Nada para corregir" : "Nothing to fix";
    case "unavailable":
      return es
        ? "Review automático no disponible: revisar a mano"
        : "Automated review unavailable: review manually";
  }
}

/** One or two sentences for the check summary: who does what. */
export function verdictSummary(result: ReviewVerdictResult, language: string | undefined): string {
  const es = verdictLanguage(language) === "es";
  switch (result.verdict) {
    case "fix":
      return es
        ? `El autor tiene que corregir ${count(result.published, "problema", "problemas")} que Jev confirmó (ver los comentarios en el código) antes de mergear.`
        : `The author has to fix ${count(result.published, "issue", "issues")} Jev confirmed (see the comments on the code) before merging.`;
    case "questions":
      return es
        ? `El autor tiene que responder ${count(result.questions, "duda", "dudas")} del comentario de Jevest. No bloquea el merge.`
        : `The author has to answer ${count(result.questions, "question", "questions")} in the Jevest comment. Not blocking.`;
    case "clear":
      return es
        ? "Jevest no encontró nada para corregir. Falta la aprobación humana habitual."
        : "Jevest found nothing to fix. The usual human approval is still needed.";
    case "unavailable":
      return es
        ? "El review automático no pudo completarse: un humano tiene que revisar el PR completo."
        : "The automated review could not be completed: a human has to review the whole PR.";
  }
}

/** Legacy label, removed on every run so PRs migrate to the verdict labels. */
export const LEGACY_NEEDS_HUMAN_LABEL = "jevest:needs-human";

const VERDICT_LABELS: Readonly<Record<VerdictLanguage, Record<ReviewVerdict, LabelDefinition>>> = {
  es: {
    fix: {
      name: "jevest: corregir antes de mergear",
      color: "b60205",
      description:
        "Jev confirmó problemas en el código: el autor tiene que corregirlos antes de mergear.",
    },
    questions: {
      name: "jevest: responder dudas",
      color: "fbca04",
      description: "Hay dudas que el autor tiene que confirmar. No bloquea por sí solo.",
    },
    clear: {
      name: "jevest: listo para aprobar",
      color: "0e8a16",
      description: "Jevest no encontró nada para corregir. Falta la aprobación humana habitual.",
    },
    unavailable: {
      name: "jevest: revisar a mano",
      color: "bfbfbf",
      description:
        "El review automático no pudo completarse: hace falta un review humano completo.",
    },
  },
  en: {
    fix: {
      name: "jevest: fix before merge",
      color: "b60205",
      description: "Jev confirmed issues in the code: the author has to fix them before merging.",
    },
    questions: {
      name: "jevest: answer questions",
      color: "fbca04",
      description: "There are doubts the author has to confirm. Not blocking on its own.",
    },
    clear: {
      name: "jevest: ready to approve",
      color: "0e8a16",
      description: "Jevest found nothing to fix. The usual human approval is still needed.",
    },
    unavailable: {
      name: "jevest: review manually",
      color: "bfbfbf",
      description: "The automated review could not be completed: a full human review is needed.",
    },
  },
};

const VERDICTS: readonly ReviewVerdict[] = ["fix", "questions", "clear", "unavailable"];

export function verdictLabel(
  verdict: ReviewVerdict,
  language: string | undefined,
): LabelDefinition {
  return VERDICT_LABELS[verdictLanguage(language)][verdict];
}

export function allVerdictLabels(language: string | undefined): LabelDefinition[] {
  return VERDICTS.map((v) => verdictLabel(v, language));
}

/** Triage's risk words (application/pipeline/stages/triage.ts `RISK_LEVELS`). */
export type RiskWord = "none" | "low" | "medium" | "high" | "critical";

const RISK_LABELS: Readonly<
  Record<VerdictLanguage, { high: LabelDefinition; medium: LabelDefinition }>
> = {
  es: {
    high: {
      name: "riesgo: alto",
      color: "d93f0b",
      description: "El triage de Jevest marcó este PR como de riesgo alto: revisarlo con cuidado.",
    },
    medium: {
      name: "riesgo: medio",
      color: "e99695",
      description: "El triage de Jevest marcó este PR como de riesgo medio.",
    },
  },
  en: {
    high: {
      name: "risk: high",
      color: "d93f0b",
      description: "Jevest triage rated this PR high risk: review it carefully.",
    },
    medium: {
      name: "risk: medium",
      color: "e99695",
      description: "Jevest triage rated this PR medium risk.",
    },
  },
};

/** high and critical share the "high" label; low and none get no label. */
export function riskLabel(risk: RiskWord, language: string | undefined): LabelDefinition | null {
  const labels = RISK_LABELS[verdictLanguage(language)];
  switch (risk) {
    case "high":
    case "critical":
      return labels.high;
    case "medium":
      return labels.medium;
    case "low":
    case "none":
      return null;
  }
}

export function allRiskLabels(language: string | undefined): LabelDefinition[] {
  const labels = RISK_LABELS[verdictLanguage(language)];
  return [labels.high, labels.medium];
}

/**
 * The verdict and risk labels for one run: exactly one verdict label added,
 * the other three removed, the legacy `jevest:needs-human` removed, and the
 * risk label added (or every risk label removed below medium). Only the
 * current language's names are managed: a repo that switches
 * `reviewer.language` keeps the old-language labels until removed by hand.
 */
export function verdictLabelChanges(
  verdict: ReviewVerdict,
  risk: RiskWord | null,
  language: string | undefined,
): { add: LabelDefinition[]; remove: string[] } {
  const chosen = verdictLabel(verdict, language);
  const riskChosen = risk === null ? null : riskLabel(risk, language);
  const add = [chosen, ...(riskChosen ? [riskChosen] : [])];
  const remove = [
    ...allVerdictLabels(language).filter((l) => l.name !== chosen.name),
    ...(risk === null ? [] : allRiskLabels(language).filter((l) => l.name !== riskChosen?.name)),
  ].map((l) => l.name);
  return { add, remove: [...remove, LEGACY_NEEDS_HUMAN_LABEL] };
}
