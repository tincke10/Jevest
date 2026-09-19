/**
 * Generic fan-out mechanics for the spike (FR-1.4, FR-3.4): packs many
 * hunks into one Jev request per batch, keyed by hunk id and question
 * name. The set of questions asked per hunk is pluggable (see
 * `question-sets/`), so the same fan-out code serves both the defect
 * question set (phase 0, H0) and the surface-profile question set
 * (phase 0b, H0').
 */
import type { JsonObject } from "../../domain/json.js";
import type { Question } from "../../domain/question.js";
import type { HunkRecord } from "./hunk-record.js";
import type { HunkSerializer } from "./serializers.js";

/** One named question within a pluggable question set. */
export interface QuestionSpec {
  readonly name: string;
  readonly build: () => Question;
}

/** A named, ordered set of questions asked per hunk. */
export interface QuestionSet {
  readonly name: string;
  readonly questions: readonly QuestionSpec[];
}

export function fanOutKey(hunkId: string, questionName: string): string {
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
 * contains "__". The caller passes the question names it expects (from
 * the same {@link QuestionSet} used to build the key).
 */
export function parseFanOutKey(
  key: string,
  questionNames: readonly string[],
): { hunkId: string; questionName: string } {
  for (const name of questionNames) {
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
 * `${hunkId}__${questionName}` for every question in `questionSet`.
 */
export function buildFanOut(
  hunks: readonly HunkRecord[],
  serializer: HunkSerializer,
  batchSize: number,
  questionSet: QuestionSet,
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
      for (const question of questionSet.questions) {
        questions[fanOutKey(hunk.id, question.name)] = question.build();
      }
    }

    batches.push({ state, questions, hunkIds: chunk.map((hunk) => hunk.id) });
  }
  return batches;
}
