/**
 * The review verdict: ONE action per run that says what has to happen
 * next, and whether it blocks. It drives the `jevest` check conclusion,
 * the check title and summary, the verdict label and the narrative's
 * closing line, so the PR list, the check and the comment can never
 * disagree ("no issues" ending with "needs changes").
 *
 * - `fix`: at least one PUBLISHED finding (high confidence, confirmed by
 *   Jev). The author must fix it. Blocks: check `failure`.
 * - `questions`: nothing published, but doubts (needs-human findings), an
 *   auto-band description mismatch, or a possible committed secret (one
 *   question per flagged hunk, NFR-3) for the author to answer or check.
 *   `neutral`.
 * - `clear`: nothing to fix or answer. `success`; the usual human approval
 *   is still needed. Whether the PR may auto-merge is the merge gate's
 *   separate call (`jevest: auto-merge ok`), not this verdict's.
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
 * Pure: no ports, no I/O. Text is es/es-AR/en (see review-language.ts); any other `reviewer.language`
 * falls back to English.
 */
import { type JevestLabelKey, labelDefinition } from "./labels.js";
import type { LabelDefinition } from "./ports/vcs-port.js";
import { type ReviewLanguage, resolveReviewLanguage } from "./review-language.js";

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
  /** Hunks where the redactor found a possible secret (NFR-3): one question each for the author. */
  readonly secretsDetected: number;
}

export interface ReviewVerdictResult {
  readonly verdict: ReviewVerdict;
  readonly published: number;
  readonly needsHuman: number;
  /** What the author has to answer: the doubts, one for a description mismatch, one per possible secret. */
  readonly questions: number;
}

export function decideReviewVerdict(input: ReviewVerdictInput): ReviewVerdictResult {
  const questions = input.needsHuman + (input.descriptionMismatch ? 1 : 0) + input.secretsDetected;
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

export type VerdictLanguage = ReviewLanguage;

/**
 * `reviewer.language` to the verdict text's variant (see review-language.ts):
 * en by default and for any non-Spanish language, es, es-AR for the
 * Rioplatense variant.
 */
export function verdictLanguage(language: string | undefined): VerdictLanguage {
  return resolveReviewLanguage(language);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The check title and the narrative's verdict line. */
export function verdictTitle(result: ReviewVerdictResult, language: string | undefined): string {
  const lang = verdictLanguage(language);
  const es = lang !== "en";
  const ar = lang === "es-AR";
  switch (result.verdict) {
    case "fix":
      return es
        ? `${ar ? "Corregí" : "Corregir"} ${count(result.published, "problema", "problemas")} antes de mergear`
        : `Fix ${count(result.published, "issue", "issues")} before merging`;
    case "questions":
      return es
        ? `${ar ? "Respondé" : "Responder"} ${count(result.questions, "duda", "dudas")} (no bloquea)`
        : `Answer ${count(result.questions, "question", "questions")} (not blocking)`;
    case "clear":
      return es ? "Nada para corregir" : "Nothing to fix";
    case "unavailable":
      return es
        ? `Review automático no disponible: ${ar ? "revisalo" : "revisar"} a mano`
        : "Automated review unavailable: review manually";
  }
}

/** One or two sentences for the check summary: who does what. */
export function verdictSummary(result: ReviewVerdictResult, language: string | undefined): string {
  const es = verdictLanguage(language) !== "en";
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

const VERDICT_LABEL_KEYS: Readonly<Record<ReviewVerdict, JevestLabelKey>> = {
  fix: "fix",
  questions: "questions",
  clear: "clear",
  unavailable: "unavailable",
};

const VERDICTS: readonly ReviewVerdict[] = ["fix", "questions", "clear", "unavailable"];

/** The verdict's label (src/domain/labels.ts): fixed English name, description in `language`. */
export function verdictLabel(
  verdict: ReviewVerdict,
  language: string | undefined,
): LabelDefinition {
  return labelDefinition(VERDICT_LABEL_KEYS[verdict], language);
}

export function allVerdictLabels(language: string | undefined): LabelDefinition[] {
  return VERDICTS.map((v) => verdictLabel(v, language));
}

/** Triage's risk words (application/pipeline/stages/triage.ts `RISK_LEVELS`). */
export type RiskWord = "none" | "low" | "medium" | "high" | "critical";

/** high and critical share the "high" label; low and none get no label. */
export function riskLabel(risk: RiskWord, language: string | undefined): LabelDefinition | null {
  switch (risk) {
    case "high":
    case "critical":
      return labelDefinition("riskHigh", language);
    case "medium":
      return labelDefinition("riskMedium", language);
    case "low":
    case "none":
      return null;
  }
}

export function allRiskLabels(language: string | undefined): LabelDefinition[] {
  return [labelDefinition("riskHigh", language), labelDefinition("riskMedium", language)];
}

/**
 * The verdict and risk labels for one run: exactly one verdict label added,
 * the other three removed, and the risk label added (or every risk label
 * removed below medium; untouched when the risk is unknown). Names do not
 * depend on `language` (only the descriptions do), so a repo that switches
 * `reviewer.language` keeps managing the same labels. Labels from earlier
 * versions are cleaned up separately (labels.ts `withLegacyLabelCleanup`).
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
  return { add, remove };
}
