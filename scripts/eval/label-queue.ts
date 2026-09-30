#!/usr/bin/env -S npx tsx
/**
 * Exports a run's unlabeled findings as JSON Lines in the golden issue
 * shape, `verdict: "unlabeled"` (docs/EVAL.md "Growing the set"): adjudicate
 * each line, set its verdict and severity, and move it into its case's
 * `issues` in the golden set.
 *
 * Usage:
 *   pnpm eval:label-queue --run <out>/<variant> [--view shown|all] [--out <file.jsonl>]
 */
import { writeFile } from "node:fs/promises";
import { buildLabelQueue } from "../../src/application/eval/eval-report.js";
import type { EvalView } from "../../src/application/eval/metrics.js";
import { loadEvalResults } from "./load-results.js";

export interface LabelQueueOptions {
  readonly run: string;
  readonly view: EvalView;
  readonly outPath: string | null;
}

export function parseLabelQueueArgs(argv: readonly string[]): LabelQueueOptions {
  let run: string | null = null;
  let view: EvalView = "shown";
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = argv[i + 1];
    if (!["--run", "--view", "--out"].includes(arg)) throw new Error(`unknown flag "${arg}"`);
    if (value === undefined) throw new Error(`flag "${arg}" requires a value`);
    i++;
    if (arg === "--run") run = value;
    else if (arg === "--out") outPath = value;
    else if (value === "shown" || value === "all") view = value;
    else throw new Error(`--view must be shown or all, got "${value}"`);
  }
  if (run === null) throw new Error("--run <out>/<variant> is required");
  return { run, view, outPath };
}

async function main(): Promise<void> {
  const options = parseLabelQueueArgs(process.argv.slice(2));
  const queue = buildLabelQueue(await loadEvalResults(options.run), options.view);
  const jsonl = queue.map((item) => JSON.stringify(item)).join("\n");
  if (options.outPath === null) {
    if (jsonl !== "") console.log(jsonl);
  } else {
    await writeFile(options.outPath, jsonl === "" ? "" : `${jsonl}\n`, "utf8");
    console.error(`[eval] wrote ${queue.length} unlabeled finding(s) to ${options.outPath}`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error("[eval] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
