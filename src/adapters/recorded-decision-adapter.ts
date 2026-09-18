/**
 * Fixture-backed DecisionPort (SPEC §10.3): "record" mode wraps another
 * adapter and persists its answers; "replay" mode reads them back and throws
 * a clear error when a fixture is missing. Fixtures are keyed by a stable
 * hash of (state, questions), so the same request always resolves to the
 * same file regardless of key insertion order.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DecisionResponse } from "../domain/decision.js";
import type { AnswersFor, DecisionPort, State } from "../domain/ports/decision-port.js";
import type { Question } from "../domain/question.js";

export class MissingFixtureError extends Error {
  constructor(key: string, fixturePath: string) {
    super(
      `no recorded fixture for key "${key}" at ${fixturePath}. Run in "record" mode against a live or fake adapter first.`,
    );
    this.name = "MissingFixtureError";
  }
}

export type RecordedDecisionAdapterMode = "record" | "replay";

export interface RecordedDecisionAdapterOptions {
  readonly fixturesDir: string;
  readonly mode: RecordedDecisionAdapterMode;
  /** Required in "record" mode: the adapter whose answers get recorded. */
  readonly underlying?: DecisionPort;
}

/** Stable hash of (state, questions), independent of object key insertion order. */
export function fixtureKey(state: State, questions: Record<string, Question>): string {
  const payload = JSON.stringify({ state: sortDeep(state), questions: sortDeep(questions) });
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

export function createRecordedDecisionAdapter(
  options: RecordedDecisionAdapterOptions,
): DecisionPort {
  const { underlying } = options;
  if (options.mode === "record" && !underlying) {
    throw new Error('RecordedDecisionAdapter in "record" mode requires an `underlying` adapter');
  }

  return {
    async decide<Q extends Record<string, Question>>(
      state: State,
      questions: Q,
    ): Promise<DecisionResponse<AnswersFor<Q>>> {
      const key = fixtureKey(state, questions);
      const fixturePath = join(options.fixturesDir, `${key}.json`);

      if (options.mode === "replay") {
        let raw: string;
        try {
          raw = await readFile(fixturePath, "utf8");
        } catch {
          throw new MissingFixtureError(key, fixturePath);
        }
        return JSON.parse(raw) as DecisionResponse<AnswersFor<Q>>;
      }

      if (!underlying) {
        throw new Error(
          'RecordedDecisionAdapter in "record" mode requires an `underlying` adapter',
        );
      }
      const response = await underlying.decide(state, questions);
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
      return response as DecisionResponse<AnswersFor<Q>>;
    },
  };
}
