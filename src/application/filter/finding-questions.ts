/**
 * The finding-filter question set (phase 1a, H1 — SPEC §5 Fase 1a step 3,
 * FR-5): per finding, Jev is asked whether it's a real defect, how severe,
 * whether it's style-only, and whether it's actionable. State per finding
 * is `{hunk, finding: {claim, rationale, file, lines}}` only — no other
 * findings, no labels, no reviewer metadata (NFR-4).
 */
import type { JsonObject } from "../../domain/json.js";
import type { NoulQuestion, Question, ScoreQuestion } from "../../domain/question.js";
import type { QuestionSet } from "../spike/questions.js";
import { fanOutKey } from "../spike/questions.js";
import type { FindingRecord } from "./finding-record.js";

export function isRealDefectQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Read the finding's claim and rationale about the hunk. Does the hunk actually have the problem the claim describes? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk contains the specific problem the claim describes; it is visible in the code shown.",
      false:
        "The hunk does not contain that problem: the claim is wrong, speculative, or about something the hunk does not show.",
    },
  };
}

export function severityQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions:
      "If the finding's claim is correct, how severe is the problem it describes? Judge only by what the hunk and the claim show.",
    criteria: [
      "Nit: a style or preference matter with no effect on correctness, such as naming or formatting.",
      "Minor: a real but low-impact issue, such as a slightly unclear pattern or a rare, low-consequence edge case.",
      "Major: an issue that plausibly causes incorrect behavior for realistic inputs, or a genuine correctness or maintainability risk.",
      "Critical: an issue that would cause a crash, data loss, a security vulnerability, or clearly incorrect behavior in the common case.",
    ],
  };
}

export function isStyleOnlyQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Is the finding's claim only about style, naming, formatting, or comments, with no effect on behavior? Judge only by what the claim and rationale say.",
    criteria: {
      true: "The claim is purely about style, naming, formatting, or comments; nothing about behavior would change either way.",
      false:
        "The claim is about behavior, correctness, or something that could affect what the code does.",
    },
  };
}

export function actionableQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "If the finding's claim is correct, does the rationale give enough specific detail for a developer to make a concrete fix, without further investigation? Judge only by what the claim and rationale say.",
    criteria: {
      true: "The rationale points to a specific location and problem clearly enough that a fix could be written directly from it.",
      false:
        "The rationale is vague, generic, or would require the developer to investigate further before knowing what to change.",
    },
  };
}

export const filterQuestionSet: QuestionSet = {
  name: "filter",
  questions: [
    { name: "is_real_defect", build: isRealDefectQuestion },
    { name: "severity", build: severityQuestion },
    { name: "is_style_only", build: isStyleOnlyQuestion },
    { name: "actionable", build: actionableQuestion },
  ],
};

/** State per finding: the hunk's raw diff plus only the finding's own claim/rationale/location (NFR-4). */
export function buildFindingState(finding: FindingRecord, hunkDiff: string): JsonObject {
  return {
    hunk: hunkDiff,
    finding: {
      claim: finding.claim,
      rationale: finding.rationale,
      file: finding.file,
      lines: { start: finding.lineStart, end: finding.lineEnd },
    },
  };
}

export interface FindingFanOutBatch {
  readonly state: JsonObject;
  readonly questions: Record<string, Question>;
  readonly findingIds: readonly string[];
}

/**
 * Packs findings into batches of at most `batchSize`, one Jev request per
 * batch, keyed by finding id (FR-1.4, FR-5.2). Reuses the generic
 * `fanOutKey` helper from the spike's fan-out mechanics.
 */
export function buildFindingFanOut(
  findings: readonly FindingRecord[],
  hunkDiffsById: ReadonlyMap<string, string>,
  batchSize: number,
): FindingFanOutBatch[] {
  if (batchSize < 1) {
    throw new RangeError(`batchSize must be >= 1, got ${batchSize}`);
  }

  const batches: FindingFanOutBatch[] = [];
  for (let i = 0; i < findings.length; i += batchSize) {
    const chunk = findings.slice(i, i + batchSize);
    const state: JsonObject = {};
    const questions: Record<string, Question> = {};

    for (const finding of chunk) {
      const hunkDiff = hunkDiffsById.get(finding.hunkId);
      if (hunkDiff === undefined) {
        throw new Error(`no hunk found for finding "${finding.id}" (hunk_id "${finding.hunkId}")`);
      }
      state[finding.id] = buildFindingState(finding, hunkDiff);
      for (const question of filterQuestionSet.questions) {
        questions[fanOutKey(finding.id, question.name)] = question.build();
      }
    }

    batches.push({ state, questions, findingIds: chunk.map((f) => f.id) });
  }
  return batches;
}
