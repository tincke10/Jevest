#!/usr/bin/env -S npx tsx
/**
 * Summary pass of the phase 0c coherence spike (H7, SPEC §4.2, §5 Fase 0c):
 * runs the claude-cli change summarizer over `datasets/prs.jsonl` and
 * records one fixture per PR under tests/fixtures/coherence/summaries/, so
 * `pnpm coherence --variant with-summary` can replay them at zero cost.
 *
 * Usage:
 *   pnpm coherence:summarize [--limit N] [--concurrency N] [--mode record|replay]
 *
 * `record` (default) calls `claude -p`, billed to the Claude subscription
 * (nominal cost is printed, SPEC §13). PRs that already have a fixture are
 * skipped, so a run interrupted by a usage limit resumes where it stopped.
 * `replay` only reads the fixtures back and prints the same totals.
 *
 * The summarizer never sees title, body or labels (summarize-prs.ts).
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCliSummarizer } from "../../src/adapters/summarizers/claude-cli-summarizer.js";
import {
  createRecordedSummarizer,
  fixtureNameForPr,
} from "../../src/adapters/summarizers/recorded-summarizer.js";
import { type PrRecord, parsePrRecordsJsonl } from "../../src/application/coherence/pr-record.js";
import { summarizePrs } from "../../src/application/coherence/summarize-prs.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRS_PATH = join(REPO_ROOT, "datasets/prs.jsonl");
export const SUMMARY_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/coherence/summaries");

const DEFAULT_CONCURRENCY = 2;
// Same policy as scripts/findings/generate.ts: sleep 60s on a rate-limit /
// usage-limit signal, up to 3 retries per PR, then stop the run.
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 60_000;

type Mode = "record" | "replay";
const MODES: readonly Mode[] = ["record", "replay"];

interface CliOptions {
  readonly limit: number | null;
  readonly concurrency: number;
  readonly mode: Mode;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let limit: number | null = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let mode: Mode = "record";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--limit": {
        const value = Number(requireValue(argv, ++i, "--limit"));
        if (!Number.isFinite(value) || value < 0)
          throw new Error(`--limit must be a non-negative number, got "${argv[i]}"`);
        limit = value;
        break;
      }
      case "--concurrency": {
        const value = Number(requireValue(argv, ++i, "--concurrency"));
        if (!Number.isInteger(value) || value < 1)
          throw new Error(`--concurrency must be an integer >= 1, got "${argv[i]}"`);
        concurrency = value;
        break;
      }
      case "--mode": {
        const value = requireValue(argv, ++i, "--mode");
        if (!MODES.includes(value as Mode)) {
          throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${value}"`);
        }
        mode = value as Mode;
        break;
      }
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { limit, concurrency, mode };
}

async function fixtureExists(prId: string): Promise<boolean> {
  try {
    await access(join(SUMMARY_FIXTURES_DIR, `${fixtureNameForPr(prId)}.json`));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  let records: PrRecord[] = parsePrRecordsJsonl(await readFile(PRS_PATH, "utf8"));
  if (options.limit !== null) {
    records = records.slice(0, options.limit);
  }

  let alreadyRecorded = 0;
  if (options.mode === "record") {
    const pending: PrRecord[] = [];
    for (const record of records) {
      if (await fixtureExists(record.id)) alreadyRecorded += 1;
      else pending.push(record);
    }
    records = pending;
    if (alreadyRecorded > 0) {
      console.log(`[coherence:summarize] skipping ${alreadyRecorded} PR(s) already recorded`);
    }
    if (records.length === 0) {
      console.log("[coherence:summarize] nothing to do: every PR already has a summary fixture");
      return 0;
    }
    console.log(
      "[coherence:summarize] record mode: calling `claude -p` (billed to the Claude subscription; nominal cost printed at the end)",
    );
  }

  const summarizer =
    options.mode === "record"
      ? createRecordedSummarizer({
          fixturesDir: SUMMARY_FIXTURES_DIR,
          mode: "record",
          underlying: createClaudeCliSummarizer(),
        })
      : createRecordedSummarizer({ fixturesDir: SUMMARY_FIXTURES_DIR, mode: "replay" });

  console.log(
    `[coherence:summarize] summarizing ${records.length} PR(s), mode=${options.mode}, concurrency=${options.concurrency}...`,
  );

  const result = await summarizePrs({
    records,
    summarizer,
    concurrency: options.concurrency,
    retry: { maxAttempts: RATE_LIMIT_MAX_ATTEMPTS, backoffMs: RATE_LIMIT_BACKOFF_MS },
    onProgress: ({ completed, total, prId }) => {
      console.log(`[coherence:summarize] ${completed}/${total} ${prId}`);
    },
  });

  if (result.failures.length > 0) {
    console.warn(`[coherence:summarize] ${result.failures.length} PR(s) failed:`);
    for (const failure of result.failures) {
      console.warn(`[coherence:summarize]   ${failure.prId}: ${failure.error}`);
    }
  }
  if (result.stoppedEarly) {
    console.warn(`[coherence:summarize] ${result.stopReason}`);
    console.warn(
      `[coherence:summarize] ${records.length - result.totals.prsAttempted} PR(s) never attempted; re-run to resume (recorded PRs are skipped)`,
    );
  }

  const t = result.totals;
  console.log("");
  console.log("[coherence:summarize] totals");
  console.log(`  PRs summarized:    ${result.summaries.size}`);
  console.log(`  already recorded:  ${alreadyRecorded}`);
  console.log(`  failures:          ${result.failures.length}`);
  console.log(
    `  input tokens:      ${t.inputTokens} (+${t.cacheInputTokens} cached/cache-creation)`,
  );
  console.log(`  output tokens:     ${t.outputTokens}`);
  console.log(`  nominal cost:      ${t.nominalCostUsd.toFixed(6)} USD`);
  console.log(`  summed latency:    ${(t.totalLatencyMs / 1000).toFixed(1)} s`);
  console.log(`  wall time:         ${(t.wallTimeMs / 1000).toFixed(1)} s`);

  return result.stoppedEarly ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[coherence:summarize] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
