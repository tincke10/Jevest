/**
 * Fixture-backed ChangeSummarizerPort, the summarizer-side twin of
 * ../reviewers/recorded-reviewer.ts: "record" mode wraps another port and
 * persists its output; "replay" mode reads it back with a loud error on a
 * miss. Fixtures live under tests/fixtures/coherence/summaries/ as
 * `<sanitized prId>.json` (one summary per PR, human-readable names so the
 * dataset and the fixtures can be diffed side by side).
 *
 * The key is the PR id alone, not a hash of the files, on purpose: a PR's
 * merged diff is immutable, so re-collecting the dataset yields the same
 * files and the same fixture stays valid.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ChangeSummarizerPort,
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";

export class MissingSummaryFixtureError extends Error {
  constructor(prId: string, fixturePath: string) {
    super(
      `no recorded summary fixture for pull request "${prId}" at ${fixturePath}. Run with --record against a live summarizer first.`,
    );
    this.name = "MissingSummaryFixtureError";
  }
}

export type RecordedSummarizerMode = "record" | "replay";

export interface RecordedSummarizerOptions {
  readonly fixturesDir: string;
  readonly mode: RecordedSummarizerMode;
  /** Required in "record" mode: the summarizer whose answers get recorded. */
  readonly underlying?: ChangeSummarizerPort;
}

/**
 * `owner/repo#42` -> `owner__repo__42`: every run of characters outside
 * `[A-Za-z0-9._-]` becomes `__`, and leading dots/underscores are dropped so
 * the name can never be a path traversal or a hidden file.
 */
export function fixtureNameForPr(prId: string): string {
  return prId.replace(/[^A-Za-z0-9._-]+/g, "__").replace(/^[._]+/, "");
}

export function createRecordedSummarizer(options: RecordedSummarizerOptions): ChangeSummarizerPort {
  const { underlying } = options;
  if (options.mode === "record" && !underlying) {
    throw new Error('RecordedSummarizer in "record" mode requires an `underlying` summarizer');
  }

  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      const fixturePath = join(options.fixturesDir, `${fixtureNameForPr(input.prId)}.json`);

      if (options.mode === "replay") {
        let raw: string;
        try {
          raw = await readFile(fixturePath, "utf8");
        } catch {
          throw new MissingSummaryFixtureError(input.prId, fixturePath);
        }
        return JSON.parse(raw) as ChangeSummaryOutput;
      }

      if (!underlying) {
        throw new Error('RecordedSummarizer in "record" mode requires an `underlying` summarizer');
      }
      const output = await underlying.summarize(input);
      // sessionId identifies a specific claude-cli session; a fixture is
      // shared/committed, so it must never carry one.
      const { sessionId: _drop, ...persisted } = output;
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      return output;
    },
  };
}
