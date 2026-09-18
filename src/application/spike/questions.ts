import type { JsonObject } from "../../domain/json.js";
/**
 * The per-hunk question set for the phase 0 spike (SPEC FR-3.2), and the
 * fan-out builder that packs many hunks into one Jev request per batch
 * (FR-1.4, FR-3.4). Criteria are written in English with explicit
 * boundaries and no double negations (NFR-6, NFR-8).
 */
import type { NoulQuestion, Question, ScoreQuestion } from "../../domain/question.js";
import type { HunkRecord } from "./hunk-record.js";
import type { HunkSerializer } from "./serializers.js";

/**
 * Score levels for `defect_likelihood`, indexed 0..3. Kept as a named
 * constant because the report's score normalization (score / (levels-1))
 * depends on this exact count.
 */
export const DEFECT_LIKELIHOOD_LEVELS = ["none", "unlikely", "likely", "certain"] as const;

export function defectLikelihoodQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions:
      "Read the code hunk shown in `before`. Does it contain a defect: a bug that causes incorrect behavior, a crash, a security flaw, or a violation of the function's evident contract? Judge only the code shown in this hunk.",
    criteria: [
      "None: the hunk is correct as written. No plausible input or usage triggers incorrect behavior.",
      "Unlikely: the hunk looks correct in the common case, but a narrow edge case, such as an unusual input or a rare ordering, might trigger incorrect behavior.",
      "Likely: the hunk has a specific, describable flaw that a normal input plausibly triggers, even though it is not certain to always fail.",
      "Certain: the hunk is definitely wrong for its evident purpose. The incorrect behavior is directly visible in the code, not merely suspected.",
    ],
  };
}

export function touchesPublicApiQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk change a function, method, class, or type that other files are meant to import and call? Judge only by what the hunk shows: exported symbols, signatures, or their documented behavior.",
    criteria: {
      true: "The hunk changes the signature, exported shape, or documented behavior of something other files import.",
      false:
        "The hunk only changes internal logic, local variables, private helpers, or test or comment code that nothing outside the file depends on.",
    },
  };
}

export function touchesSecurityQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk touch authentication, authorization, cryptography, secrets, session handling, or sanitization of untrusted input? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk changes code that checks identity or permissions, encrypts, decrypts, or hashes data, handles credentials or tokens, or sanitizes untrusted input.",
      false:
        "The hunk changes unrelated logic, formatting, or business rules with no connection to any of those concerns.",
    },
  };
}

const QUESTION_NAMES = ["defect_likelihood", "touches_public_api", "touches_security"] as const;
export type FanOutQuestionName = (typeof QUESTION_NAMES)[number];

export function fanOutKey(hunkId: string, questionName: FanOutQuestionName): string {
  return `${hunkId}__${questionName}`;
}

export class FanOutKeyError extends Error {
  constructor(key: string) {
    super(`fan-out key "${key}" does not end with a known question name`);
    this.name = "FanOutKeyError";
  }
}

/**
 * Inverse of {@link fanOutKey}. Matches by known question-name suffix
 * (not by first "__"), so it round-trips even if a hunk id itself
 * contains "__".
 */
export function parseFanOutKey(key: string): { hunkId: string; questionName: FanOutQuestionName } {
  for (const name of QUESTION_NAMES) {
    const suffix = `__${name}`;
    if (key.endsWith(suffix)) {
      return { hunkId: key.slice(0, key.length - suffix.length), questionName: name };
    }
  }
  throw new FanOutKeyError(key);
}

export interface FanOutBatch {
  readonly state: JsonObject;
  readonly questions: Record<string, Question>;
  readonly hunkIds: readonly string[];
}

/**
 * Packs hunks into batches of at most `batchSize`, one Jev request per
 * batch (FR-1.4, FR-3.4): state is keyed by hunk id, questions are keyed
 * `${hunkId}__${questionName}`.
 */
export function buildFanOut(
  hunks: readonly HunkRecord[],
  serializer: HunkSerializer,
  batchSize: number,
): FanOutBatch[] {
  if (batchSize < 1) {
    throw new RangeError(`batchSize must be >= 1, got ${batchSize}`);
  }

  const batches: FanOutBatch[] = [];
  for (let i = 0; i < hunks.length; i += batchSize) {
    const chunk = hunks.slice(i, i + batchSize);
    const state: JsonObject = {};
    const questions: Record<string, Question> = {};

    for (const hunk of chunk) {
      state[hunk.id] = serializer.serialize(hunk);
      questions[fanOutKey(hunk.id, "defect_likelihood")] = defectLikelihoodQuestion();
      questions[fanOutKey(hunk.id, "touches_public_api")] = touchesPublicApiQuestion();
      questions[fanOutKey(hunk.id, "touches_security")] = touchesSecurityQuestion();
    }

    batches.push({ state, questions, hunkIds: chunk.map((hunk) => hunk.id) });
  }
  return batches;
}
