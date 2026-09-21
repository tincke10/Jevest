#!/usr/bin/env -S npx tsx
/**
 * Phase 0c intent–change coherence spike CLI (H7, SPEC §4.2, §5 Fase 0c):
 * asks Jev the coherence question set about every pair in
 * `datasets/coherence-pairs.jsonl`, in one or both variants, and writes the
 * H7 report. Mirrors `scripts/spike/run-profile.ts`'s modes and flags.
 *
 * Usage:
 *   pnpm coherence [--variant with-summary|without-summary|all] [--limit N]
 *                  [--seed N] [--mode live|record|replay|dry-run]
 *
 * The with-summary variant replays the summary fixtures written by
 * `pnpm coherence:summarize` (tests/fixtures/coherence/summaries/) and
 * refuses to run with any of them missing: an arm with holes would measure
 * a mix of both arms. Jev fixtures live under
 * tests/fixtures/coherence/decisions/<variant>/.
 *
 * H7 is non-blocking (SPEC §4.2): this CLI always exits 0 unless the run
 * itself errors.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createRecordedSummarizer } from "../../src/adapters/summarizers/recorded-summarizer.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import {
  type CoherenceSpikeReport,
  type SummarizerPassSummary,
  buildCoherenceReport,
  renderCoherenceReportMarkdown,
} from "../../src/application/coherence/coherence-report.js";
import {
  COHERENCE_VARIANTS,
  type CoherenceRunResult,
  type CoherenceVariant,
  runCoherenceSpike,
} from "../../src/application/coherence/coherence-runner.js";
import { generateDryRunCoherenceScript } from "../../src/application/coherence/dry-run-coherence-script.js";
import {
  type CoherencePair,
  type PrRecord,
  parseCoherencePairsJsonl,
  parsePrRecordsJsonl,
} from "../../src/application/coherence/pr-record.js";
import { summarizePrs } from "../../src/application/coherence/summarize-prs.js";
import { stratifiedSampleBy } from "../../src/application/spike/stratified-sample.js";
import type { ChangeSummary } from "../../src/domain/ports/change-summarizer-port.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRS_PATH = join(REPO_ROOT, "datasets/prs.jsonl");
const PAIRS_PATH = join(REPO_ROOT, "datasets/coherence-pairs.jsonl");
const SUMMARY_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/coherence/summaries");
const DECISION_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/coherence/decisions");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;
const DEFAULT_SAMPLE_SEED = 42;

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];
type VariantFlag = CoherenceVariant | "all";

interface CliOptions {
  readonly variant: VariantFlag;
  readonly limit: number | null;
  readonly mode: Mode | null;
  readonly seed: number;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let variant: VariantFlag = "all";
  let limit: number | null = null;
  let mode: Mode | null = null;
  let seed = DEFAULT_SAMPLE_SEED;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--variant": {
        const value = requireValue(argv, ++i, "--variant");
        if (value !== "all" && !COHERENCE_VARIANTS.includes(value as CoherenceVariant)) {
          throw new Error(
            `--variant must be one of ${[...COHERENCE_VARIANTS, "all"].join(", ")}, got "${value}"`,
          );
        }
        variant = value as VariantFlag;
        break;
      }
      case "--limit": {
        const value = Number(requireValue(argv, ++i, "--limit"));
        if (!Number.isFinite(value) || value < 0)
          throw new Error(`--limit must be a non-negative number, got "${argv[i]}"`);
        limit = value;
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
      case "--seed": {
        const value = Number(requireValue(argv, ++i, "--seed"));
        if (!Number.isFinite(value)) throw new Error(`--seed must be a number, got "${argv[i]}"`);
        seed = value;
        break;
      }
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { variant, limit, mode, seed };
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function resolveMode(
  requested: Mode | null,
  variants: readonly CoherenceVariant[],
): Promise<Mode> {
  if (requested) return requested;
  for (const variant of variants) {
    if (await hasEntries(join(DECISION_FIXTURES_DIR, variant))) return "replay";
  }
  return "dry-run";
}

function requireApiKey(mode: Mode): void {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error(`mode "${mode}" requires TYPESAFE_API_KEY to be set`);
  }
}

function buildPort(mode: Mode, variant: CoherenceVariant): DecisionPort {
  const fixturesDir = join(DECISION_FIXTURES_DIR, variant);
  switch (mode) {
    case "dry-run":
      return createFakeDecisionAdapter(generateDryRunCoherenceScript(DRY_RUN_SEED));
    case "live": {
      requireApiKey(mode);
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      return createTypeSafeDecisionAdapter({ client });
    }
    case "record": {
      requireApiKey(mode);
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      const underlying = createTypeSafeDecisionAdapter({ client });
      return createRecordedDecisionAdapter({ fixturesDir, mode: "record", underlying });
    }
    case "replay":
      return createRecordedDecisionAdapter({ fixturesDir, mode: "replay" });
  }
}

/**
 * Replays the summary fixtures for every CHANGE PR referenced by the pairs.
 * Any missing fixture is a hard error: the with-summary arm must be whole.
 */
async function loadSummaries(
  records: readonly PrRecord[],
  pairs: readonly CoherencePair[],
): Promise<{ summaries: Map<string, ChangeSummary>; pass: SummarizerPassSummary }> {
  const needed = new Set(pairs.map((p) => p.prId));
  const wanted = records.filter((r) => needed.has(r.id));
  const replay = createRecordedSummarizer({ fixturesDir: SUMMARY_FIXTURES_DIR, mode: "replay" });
  const result = await summarizePrs({ records: wanted, summarizer: replay, concurrency: 8 });

  if (result.failures.length > 0) {
    const ids = result.failures.map((f) => f.prId);
    throw new Error(
      `variant "with-summary" needs a summary fixture for every PR; ${ids.length} missing under ${SUMMARY_FIXTURES_DIR}: ${ids.join(", ")}. Run \`pnpm coherence:summarize --mode record\` first.`,
    );
  }

  const summaries = new Map<string, ChangeSummary>();
  for (const [prId, output] of result.summaries) {
    summaries.set(prId, output.summary);
  }
  return {
    summaries,
    pass: {
      prCount: result.summaries.size,
      failures: 0,
      inputTokens: result.totals.inputTokens,
      outputTokens: result.totals.outputTokens,
      nominalCostUsd: result.totals.nominalCostUsd,
      totalLatencyMs: result.totals.totalLatencyMs,
    },
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const variants: readonly CoherenceVariant[] =
    options.variant === "all" ? COHERENCE_VARIANTS : [options.variant];
  const mode = await resolveMode(options.mode, variants);

  const [prsRaw, pairsRaw] = await Promise.all([
    readFile(PRS_PATH, "utf8"),
    readFile(PAIRS_PATH, "utf8"),
  ]);
  const records = parsePrRecordsJsonl(prsRaw);
  let pairs = parseCoherencePairsJsonl(pairsRaw);

  if (options.limit !== null) {
    pairs = stratifiedSampleBy(pairs, (p) => p.label === "incoherent", {
      limit: options.limit,
      seed: options.seed,
    });
    console.warn(
      `[coherence] WARNING: --limit ${options.limit} is a smoke test (seed=${options.seed}), not evidence for H7.`,
    );
  }

  let summaries: Map<string, ChangeSummary> | null = null;
  let summarizerPass: SummarizerPassSummary | undefined;
  if (variants.includes("with-summary")) {
    const loaded = await loadSummaries(records, pairs);
    summaries = loaded.summaries;
    summarizerPass = loaded.pass;
    console.log(`[coherence] loaded ${summaries.size} summary fixture(s) for with-summary`);
  }

  const runs: CoherenceRunResult[] = [];
  for (const variant of variants) {
    const port = buildPort(mode, variant);
    console.log(
      `[coherence] running variant "${variant}" (${pairs.length} pairs, mode=${mode}, one request per pair)...`,
    );
    const run = await runCoherenceSpike({
      port,
      records,
      pairs,
      summaries: variant === "with-summary" ? summaries : null,
      variant,
      onProgress: ({ completedPairs, totalPairs }) => {
        const line = `[coherence] ${variant}: pair ${completedPairs}/${totalPairs}`;
        process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
      },
    });
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    if (run.failures.length > 0) {
      console.warn(`[coherence] ${run.failures.length} pair(s) failed for variant "${variant}":`);
      for (const failure of run.failures) {
        console.warn(`[coherence]   ${failure.pairId}: ${failure.error}`);
      }
    }
    runs.push(run);
  }

  const report: CoherenceSpikeReport = buildCoherenceReport(runs, records, {
    ...(summarizerPass !== undefined ? { summarizer: summarizerPass } : {}),
  });
  const markdown = renderCoherenceReportMarkdown(report);

  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(REPORTS_DIR, `spike-coherence-${timestamp}.json`);
  const mdPath = join(REPORTS_DIR, `spike-coherence-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[coherence] wrote ${jsonPath}`);
  console.log(`[coherence] wrote ${mdPath}`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[coherence] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
