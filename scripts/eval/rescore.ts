#!/usr/bin/env -S npx tsx
/**
 * Re-scores a stored eval run against a (possibly updated) golden set
 * WITHOUT re-running the pipeline (docs/EVAL.md "Re-scoring a run").
 *
 * Usage:
 *   pnpm eval:rescore --run <out>/<variant> --set <golden.jsonl>
 *     [--matcher llm|prefilter] [--matcher-model <model>] [--matcher-effort <level>]
 *     [--matcher-concurrency <n>] [--concurrency <n>] [--as <newVariantName>]
 *
 * The candidates come from the run's results.json (every case's
 * `candidates`, kept with their claim, failing scenario and evidence), its
 * cost, tokens, wall time and errors are kept, and the result is written to
 * `<run>/results.json` + `report.md` — or to `<out>/<as>/` with `--as`,
 * leaving the run untouched. The matcher cache is the run's
 * `<out>/matcher-cache/`, shared with `pnpm eval:review`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { renderEvalReport } from "../../src/application/eval/eval-report.js";
import { parseGoldenSetJsonl } from "../../src/application/eval/golden-set.js";
import { rescoreRun } from "../../src/application/eval/rescore.js";
import { loadEvalResults } from "./load-results.js";
import {
  DEFAULT_MATCHER_EFFORT,
  DEFAULT_MATCHER_MODEL,
  type MatcherKind,
  type MatcherOptions,
  buildMatcher,
  parseMatcherEffort,
  parseMatcherKind,
  parsePositiveInt,
} from "./matcher-options.js";

const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RescoreCliOptions extends MatcherOptions {
  /** The stored run: `<out>/<variant>`. */
  readonly runDir: string;
  readonly setPath: string;
  /** Write a new variant `<out>/<as>` instead of overwriting the run. */
  readonly as: string | null;
  readonly matcherConcurrency: number;
  readonly concurrency: number;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`flag "${flag}" requires a value`);
  return value;
}

export function parseRescoreArgs(argv: readonly string[]): RescoreCliOptions {
  let runDir: string | null = null;
  let setPath: string | null = null;
  let as: string | null = null;
  let matcher: MatcherKind = "claude-cli";
  let matcherModel = DEFAULT_MATCHER_MODEL;
  let matcherEffort = DEFAULT_MATCHER_EFFORT;
  let matcherConcurrency = 4;
  let concurrency = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--run":
        runDir = requireValue(argv, ++i, arg);
        break;
      case "--set":
        setPath = requireValue(argv, ++i, arg);
        break;
      case "--as":
        as = requireValue(argv, ++i, arg);
        if (!VARIANT_RE.test(as)) {
          throw new Error("--as <name> must be letters, digits, '.', '_', '-'");
        }
        break;
      case "--matcher":
        matcher = parseMatcherKind(requireValue(argv, ++i, arg));
        break;
      case "--matcher-model":
        matcherModel = requireValue(argv, ++i, arg);
        break;
      case "--matcher-effort":
        matcherEffort = parseMatcherEffort(requireValue(argv, ++i, arg));
        break;
      case "--matcher-concurrency":
        matcherConcurrency = parsePositiveInt(requireValue(argv, ++i, arg), arg);
        break;
      case "--concurrency":
        concurrency = parsePositiveInt(requireValue(argv, ++i, arg), arg);
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }
  if (runDir === null) throw new Error("--run <out>/<variant> is required");
  if (setPath === null) throw new Error("--set <golden.jsonl> is required");
  return {
    runDir,
    setPath,
    as,
    matcher,
    matcherModel,
    matcherEffort,
    matcherConcurrency,
    concurrency,
  };
}

export async function runRescoreCli(
  options: RescoreCliOptions,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const runDir = resolve(options.runDir);
  const outDir = dirname(runDir);
  const previous = await loadEvalResults(runDir);
  const cases = parseGoldenSetJsonl(await readFile(options.setPath, "utf8"));
  const variant = options.as ?? previous.variant ?? basename(runDir);
  const targetDir = options.as === null ? runDir : join(outDir, options.as);
  const { matcher, info } = buildMatcher(options, outDir);

  const results = await rescoreRun({
    previous,
    runPath: options.runDir,
    variant,
    setPath: options.setPath,
    cases,
    matcher,
    matcherInfo: info,
    matcherConcurrency: options.matcherConcurrency,
    concurrency: options.concurrency,
    log,
  });

  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const report = renderEvalReport(results);
  await writeFile(join(targetDir, "report.md"), report, "utf8");
  log(report);
  log(`[rescore] wrote ${join(targetDir, "results.json")} and report.md`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  runRescoreCli(parseRescoreArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("[rescore] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
