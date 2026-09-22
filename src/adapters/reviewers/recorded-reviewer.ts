/**
 * Fixture-backed ReviewerPort, the reviewer-side twin of
 * ../recorded-decision-adapter.ts: "record" mode wraps another ReviewerPort
 * and persists its ReviewOutput; "replay" mode reads it back with a loud
 * error on a miss. Used by `scripts/findings/generate.ts --record` to save
 * raw responses under tests/fixtures/findings/ for replay tests (SPEC §10.3).
 *
 * "record" mode is resumable: an input whose fixture already exists is
 * served from disk and the underlying reviewer is not called, so an
 * interrupted 100-hunk run can be re-launched and only pays for what is
 * missing. Delete the fixture to force a fresh recording.
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

async function readFixture(fixturePath: string): Promise<ReviewOutput | null> {
  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(raw) as ReviewOutput;
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
        const recorded = await readFixture(fixturePath);
        if (recorded === null) {
          throw new MissingReviewFixtureError(key, fixturePath);
        }
        return recorded;
      }

      if (!underlying) {
        throw new Error('RecordedReviewer in "record" mode requires an `underlying` reviewer');
      }
      const existing = await readFixture(fixturePath);
      if (existing !== null) {
        return existing;
      }
      const output = await underlying.review(input);
      // sessionId identifies a specific claude-cli session; a fixture is
      // shared/committed, so it must never carry one (the caller still gets
      // it in the returned `output`, just not what lands on disk).
      const { sessionId: _drop, ...persisted } = output;
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      return output;
    },
  };
}
