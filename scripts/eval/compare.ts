#!/usr/bin/env -S npx tsx
/**
 * Side-by-side headline table of eval runs (docs/EVAL.md "Comparing").
 *
 * Usage:
 *   pnpm eval:compare <runDirA> <runDirB> ... [--out <file.md>]
 *
 * Each run is a `<out>/<variant>` directory written by `pnpm eval:review`
 * (or its results.json).
 */
import { writeFile } from "node:fs/promises";
import { renderComparison } from "../../src/application/eval/eval-report.js";
import { loadEvalResults } from "./load-results.js";

export interface CompareOptions {
  readonly runs: readonly string[];
  readonly outPath: string | null;
}

export function parseCompareArgs(argv: readonly string[]): CompareOptions {
  const runs: string[] = [];
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error('flag "--out" requires a value');
      outPath = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else {
      runs.push(arg);
    }
  }
  if (runs.length === 0) throw new Error("pass at least one run directory");
  return { runs, outPath };
}

async function main(): Promise<void> {
  const options = parseCompareArgs(process.argv.slice(2));
  const results = await Promise.all(options.runs.map(loadEvalResults));
  const table = renderComparison(results);
  console.log(table);
  if (options.outPath !== null) {
    await writeFile(options.outPath, table, "utf8");
    console.log(`[eval] wrote ${options.outPath}`);
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
