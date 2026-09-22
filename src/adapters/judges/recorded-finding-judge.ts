/**
 * Fixture-backed FindingJudgePort, the judge-side twin of
 * ../reviewers/recorded-reviewer.ts: "record" mode wraps another port and
 * persists its output (resumable: an existing fixture is served from disk
 * and the underlying judge is not called); "replay" mode reads it back
 * with a loud error on a miss. Fixtures live under
 * tests/fixtures/filter-judge/ as `<sha256 of the input>.json`.
 *
 * The key hashes the whole input, not the finding id alone, on purpose:
 * the strict and thorough findings datasets reuse ids
 * (`${hunk}::${provider}::${n}`) for different claims, and a judgment is
 * about the claim, not the id.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";

export class MissingJudgeFixtureError extends Error {
  constructor(findingId: string, fixturePath: string) {
    super(
      `no recorded judge fixture for finding "${findingId}" at ${fixturePath}. Run with --judge-mode record against a live judge first.`,
    );
    this.name = "MissingJudgeFixtureError";
  }
}

export type RecordedFindingJudgeMode = "record" | "replay";

export interface RecordedFindingJudgeOptions {
  readonly fixturesDir: string;
  readonly mode: RecordedFindingJudgeMode;
  /** Required in "record" mode: the judge whose answers get recorded. */
  readonly underlying?: FindingJudgePort;
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

/** Stable hash of a FindingJudgeInput, independent of object key insertion order. */
export function fixtureKeyForJudgeInput(input: FindingJudgeInput): string {
  return createHash("sha256")
    .update(JSON.stringify(sortDeep(input)))
    .digest("hex");
}

async function readFixture(fixturePath: string): Promise<FindingJudgeOutput | null> {
  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(raw) as FindingJudgeOutput;
}

export function createRecordedFindingJudge(options: RecordedFindingJudgeOptions): FindingJudgePort {
  const { underlying } = options;
  if (options.mode === "record" && !underlying) {
    throw new Error('RecordedFindingJudge in "record" mode requires an `underlying` judge');
  }

  return {
    async judge(input: FindingJudgeInput): Promise<FindingJudgeOutput> {
      const fixturePath = join(options.fixturesDir, `${fixtureKeyForJudgeInput(input)}.json`);
      const existing = await readFixture(fixturePath);

      if (options.mode === "replay") {
        if (existing === null) {
          throw new MissingJudgeFixtureError(input.findingId, fixturePath);
        }
        return existing;
      }
      if (existing !== null) {
        return existing;
      }
      if (!underlying) {
        throw new Error('RecordedFindingJudge in "record" mode requires an `underlying` judge');
      }
      const output = await underlying.judge(input);
      // sessionId identifies a specific claude-cli session; a fixture is
      // shared/committed, so it must never carry one.
      const { sessionId: _drop, ...persisted } = output;
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      return output;
    },
  };
}
