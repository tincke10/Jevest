/**
 * Fixture-backed FindingLabelerPort, the labeler-side twin of
 * ../judges/recorded-finding-judge.ts: "record" mode wraps another port and
 * persists its output (resumable — an existing fixture is served from disk
 * and the underlying labeler is not called); "replay" mode reads it back with
 * a loud error on a miss. Fixtures live under tests/fixtures/findings-oracle/
 * as `<sha256 of the input + framing>.json`.
 *
 * The key hashes the whole input, the framing and — when the caller names one
 * — the labeler:
 * - the framing, because the two passes must never collide — they are two
 *   different questions and sharing a fixture would collapse the agreement
 *   check into a tautology;
 * - the whole input rather than the finding id, because the strict and
 *   thorough datasets reuse ids (`${hunk}::${provider}::${n}`) for different
 *   claims, and because re-fetching an issue body changes what the labeler
 *   was shown, which must invalidate the label rather than silently reuse it;
 * - the labeler, because the input alone says what the model was SHOWN, not
 *   which model answered. `labelerId` is optional and absent from the hash
 *   when unset, so the 591 DeepSeek fixtures recorded before it existed keep
 *   replaying unchanged.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ClaimVerificationOutput,
  FindingLabelerInput,
  FindingLabelerOutput,
  FindingLabelerPort,
  FixMatchOutput,
  LabelerFraming,
} from "../../domain/ports/finding-labeler-port.js";

export class MissingLabelFixtureError extends Error {
  constructor(findingId: string, framing: LabelerFraming, fixturePath: string) {
    super(
      `no recorded ${framing} oracle-label fixture for finding "${findingId}" at ${fixturePath}. Run with --mode record against a live labeler first.`,
    );
    this.name = "MissingLabelFixtureError";
  }
}

export type RecordedFindingLabelerMode = "record" | "replay";

export interface RecordedFindingLabelerOptions {
  readonly fixturesDir: string;
  readonly mode: RecordedFindingLabelerMode;
  /** Required in "record" mode: the labeler whose answers get recorded. */
  readonly underlying?: FindingLabelerPort;
  /**
   * Which labeler these fixtures belong to, mixed into the key. Absent means
   * the historical, unnamespaced key — the 591 DeepSeek fixtures recorded
   * before this existed, which must keep replaying byte-for-byte. Pass it for
   * any other labeler so a DeepSeek label can never be served to a claude-cli
   * run: the key hashes what the model was SHOWN, and two models shown the
   * same thing are still two different answers.
   */
  readonly labelerId?: string;
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

/**
 * Stable hash of (input, framing) and, when given, the labeler it belongs to.
 * Independent of object key insertion order. `labelerId` is omitted from the
 * hashed object entirely when absent, so an unnamespaced key is byte-identical
 * to what this function produced before `labelerId` existed.
 */
export function fixtureKeyForLabelerInput(
  input: FindingLabelerInput,
  framing: LabelerFraming,
  labelerId?: string,
): string {
  const payload =
    labelerId === undefined ? { framing, input } : { framing, input, labeler: labelerId };
  return createHash("sha256")
    .update(JSON.stringify(sortDeep(payload)))
    .digest("hex");
}

async function readFixture(fixturePath: string): Promise<FindingLabelerOutput | null> {
  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(raw) as FindingLabelerOutput;
}

export function createRecordedFindingLabeler(
  options: RecordedFindingLabelerOptions,
): FindingLabelerPort {
  const { underlying } = options;
  if (options.mode === "record" && !underlying) {
    throw new Error('RecordedFindingLabeler in "record" mode requires an `underlying` labeler');
  }

  async function label(
    input: FindingLabelerInput,
    framing: LabelerFraming,
  ): Promise<FindingLabelerOutput> {
    const fixturePath = join(
      options.fixturesDir,
      `${fixtureKeyForLabelerInput(input, framing, options.labelerId)}.json`,
    );
    const existing = await readFixture(fixturePath);

    if (options.mode === "replay") {
      if (existing === null) {
        throw new MissingLabelFixtureError(input.findingId, framing, fixturePath);
      }
      return existing;
    }
    if (existing !== null) {
      return existing;
    }
    if (!underlying) {
      throw new Error('RecordedFindingLabeler in "record" mode requires an `underlying` labeler');
    }
    const output =
      framing === "fix-match"
        ? await underlying.labelFixMatch(input)
        : await underlying.labelClaimVerification(input);
    // sessionId identifies a specific provider session; a fixture is
    // shared/committed, so it must never carry one.
    const { sessionId: _drop, ...persisted } = output;
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    return output;
  }

  return {
    async labelFixMatch(input) {
      return (await label(input, "fix-match")) as FixMatchOutput;
    },
    async labelClaimVerification(input) {
      return (await label(input, "claim-verification")) as ClaimVerificationOutput;
    },
  };
}
