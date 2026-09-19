/**
 * Fixture-backed ReviewerPort, the reviewer-side twin of
 * ../recorded-decision-adapter.ts: "record" mode wraps another ReviewerPort
 * and persists its ReviewOutput; "replay" mode reads it back with a loud
 * error on a miss. Used by `scripts/findings/generate.ts --record` to save
 * raw responses under tests/fixtures/findings/ for replay tests (SPEC §10.3).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";

export class MissingReviewFixtureError extends Error {
  constructor(key: string, fixturePath: string) {
    super(
      `no recorded review fixture for key "${key}" at ${fixturePath}. Run with --record against a live reviewer first.`,
    );
    this.name = "MissingReviewFixtureError";
  }
}

export type RecordedReviewerMode = "record" | "replay";

export interface RecordedReviewerOptions {
  readonly fixturesDir: string;
  readonly mode: RecordedReviewerMode;
  /** Required in "record" mode: the reviewer whose answers get recorded. */
  readonly underlying?: ReviewerPort;
}

/** Stable hash of a ReviewInput, independent of object key insertion order. */
export function fixtureKeyForReview(input: ReviewInput): string {
  const payload = JSON.stringify(sortDeep(input));
  return createHash("sha256").update(payload).digest("hex");
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function createRecordedReviewer(options: RecordedReviewerOptions): ReviewerPort {
  const { underlying } = options;
  if (options.mode === "record" && !underlying) {
    throw new Error('RecordedReviewer in "record" mode requires an `underlying` reviewer');
  }

  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const key = fixtureKeyForReview(input);
      const fixturePath = join(options.fixturesDir, `${key}.json`);

      if (options.mode === "replay") {
        let raw: string;
        try {
          raw = await readFile(fixturePath, "utf8");
        } catch {
          throw new MissingReviewFixtureError(key, fixturePath);
        }
        return JSON.parse(raw) as ReviewOutput;
      }

      if (!underlying) {
        throw new Error('RecordedReviewer in "record" mode requires an `underlying` reviewer');
      }
      const output = await underlying.review(input);
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return output;
    },
  };
}
