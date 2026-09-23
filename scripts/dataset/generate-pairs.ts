#!/usr/bin/env -S npx tsx
/**
 * generate-pairs.ts — regenerates `datasets/coherence-pairs*.jsonl` from an
 * already-collected `datasets/prs.jsonl`, with no GitHub calls. Wraps
 * `generateCoherencePairs` (src/application/coherence/pr-selection.ts),
 * which owns both crossing strategies:
 *
 *   "random" (default) — seeded same-repo derangement, byte-identical to
 *     what `scripts/dataset/collect-prs.ts` writes for the same seed. Use
 *     this to regenerate `datasets/coherence-pairs.jsonl` without a full
 *     re-scan of GitHub.
 *   "hard" — most-similar-by-change-footprint same-repo crossing, a
 *     near-duplicate negative. Use this to produce
 *     `datasets/coherence-pairs-hard.jsonl`.
 *
 * Usage:
 *   pnpm dataset:pairs [--prs <path>] [--out <path>] [--seed N]
 *                      [--strategy random|hard]
 *
 * Defaults: --prs datasets/prs.jsonl, --out datasets/coherence-pairs.jsonl,
 * --seed 42, --strategy random (so a bare `pnpm dataset:pairs` reproduces
 * today's file).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PrRecord,
  parsePrRecordsJsonl,
  stringifyCoherencePair,
} from "../../src/application/coherence/pr-record.js";
import {
  type Distribution,
  countBasenameLeaks,
  describeDistribution,
  generateCoherencePairs,
} from "../../src/application/coherence/pr-selection.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_PRS_PATH = join(REPO_ROOT, "datasets/prs.jsonl");
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/coherence-pairs.jsonl");
const DEFAULT_SEED = 42;

export type Strategy = "random" | "hard";
const STRATEGIES: readonly Strategy[] = ["random", "hard"];

export interface CliOptions {
  readonly prsPath: string;
  readonly outPath: string;
  readonly seed: number;
  readonly strategy: Strategy;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let prsPath = DEFAULT_PRS_PATH;
  let outPath = DEFAULT_OUT_PATH;
  let seed = DEFAULT_SEED;
  let strategy: Strategy = "random";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--prs":
        prsPath = requireValue(argv, ++i, "--prs");
        break;
      case "--out":
        outPath = requireValue(argv, ++i, "--out");
        break;
      case "--seed": {
        const value = Number(requireValue(argv, ++i, "--seed"));
        if (!Number.isFinite(value)) throw new Error(`--seed must be a number, got "${argv[i]}"`);
        seed = value;
        break;
      }
      case "--strategy": {
        const value = requireValue(argv, ++i, "--strategy");
        if (!STRATEGIES.includes(value as Strategy)) {
          throw new Error(`--strategy must be one of ${STRATEGIES.join(", ")}, got "${value}"`);
        }
        strategy = value as Strategy;
        break;
      }
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { prsPath, outPath, seed, strategy };
}

/** Nearest-rank percentile, same method as {@link describeDistribution}'s internals. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function fmtDistribution(label: string, d: Distribution): string {
  return `  ${label.padEnd(16)} n=${d.n} min=${d.min.toFixed(3)} p25=${d.p25.toFixed(3)} p50=${d.p50.toFixed(3)} p75=${d.p75.toFixed(3)} p90=${d.p90.toFixed(3)} max=${d.max.toFixed(3)}`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const raw = await readFile(options.prsPath, "utf8");
  const records: PrRecord[] = parsePrRecordsJsonl(raw, options.prsPath);
  const pairs = generateCoherencePairs(records, options.seed, options.strategy);
  const leaks = countBasenameLeaks(records, pairs);

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(
    options.outPath,
    pairs.map((p) => `${stringifyCoherencePair(p)}\n`).join(""),
    "utf8",
  );

  console.log(
    `[pairs] strategy=${options.strategy} seed=${options.seed} records=${records.length} pairs=${pairs.length}`,
  );
  console.log(`[pairs] wrote ${options.outPath}`);
  console.log(`[pairs] basename leaks (incoherent pairs): ${leaks}`);

  if (options.strategy === "hard") {
    const similarities = pairs
      .map((p) => p.crossing?.similarity)
      .filter((s): s is number => s !== undefined);
    console.log(fmtDistribution("dir jaccard", describeDistribution(similarities)));
    console.log(
      `  ${"percentiles".padEnd(16)} p10=${percentile(similarities, 10).toFixed(3)} p50=${percentile(similarities, 50).toFixed(3)} p90=${percentile(similarities, 90).toFixed(3)}`,
    );

    const donorReuse = new Map<string, number>();
    for (const p of pairs) {
      if (p.crossing === undefined) continue;
      donorReuse.set(p.crossing.donorPr, (donorReuse.get(p.crossing.donorPr) ?? 0) + 1);
    }
    const reusedOnce = [...donorReuse.values()].filter((n) => n === 1).length;
    const reusedTwice = [...donorReuse.values()].filter((n) => n === 2).length;
    const reusedOther = [...donorReuse.values()].filter((n) => n !== 1 && n !== 2).length;
    console.log(
      `  donor reuse       distinct-donors=${donorReuse.size} used-once=${reusedOnce} used-twice=${reusedTwice}${reusedOther > 0 ? ` UNEXPECTED-reuse=${reusedOther}` : ""}`,
    );
  }

  return 0;
}

// Guard so importing parseArgs (unit tests) never triggers a run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[pairs] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
