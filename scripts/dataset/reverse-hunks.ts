#!/usr/bin/env -S npx tsx
/**
 * reverse-hunks.ts — builds `datasets/hunks-reversed.jsonl`, the H1b reviewer
 * set (datasets/FINDINGS.md §11).
 *
 * `datasets/hunks.jsonl` shows the reviewer the bugfix commit's own diff, so
 * every defect hunk is a change that ALREADY removes the defect. Under the
 * fix-aware oracle label that yielded 7 real findings out of 299: a finding
 * can only be `real` when it happens to name the defect being removed. This
 * script flips the reviewer's view for the 50 defect hunks — the diff runs
 * after -> before, so the "PR" is the change that INTRODUCES the bug — and a
 * real finding becomes one that flags the bug the real fix later removed.
 *
 * The 50 benign hunks are copied unchanged (same ids, same diffs, plus an
 * explicit `orientation: "original"`), so the reviewer set still mixes both
 * kinds at the same 50/50 split.
 *
 * Only `diff` and `id` move. `before`, `after`, `label`, `evidence`,
 * `hunk_header`, `file`, `language`, `repo`, `commit` and `parent` stay in
 * ORIGINAL orientation, because the oracle labeler must keep seeing
 * `before` = buggy and `after` = fixed. It is the reviewer's view that is
 * reversed, never the ground truth's.
 *
 * Pure local computation: no network, no LLM, no cost. It NEVER writes to
 * `datasets/hunks.jsonl`.
 *
 * Usage:
 *   pnpm dataset:reverse [--hunks <path>] [--out <path>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reverseHunkJsonl } from "../../src/application/spike/reverse-hunk.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/hunks-reversed.jsonl");

export interface CliOptions {
  readonly hunksPath: string;
  readonly outPath: string;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let hunksPath = DEFAULT_HUNKS_PATH;
  let outPath = DEFAULT_OUT_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--hunks":
        hunksPath = requireValue(argv, ++i, "--hunks");
        break;
      case "--out":
        outPath = requireValue(argv, ++i, "--out");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { hunksPath, outPath };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const raw = await readFile(options.hunksPath, "utf8");
  const result = reverseHunkJsonl(raw);

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, result.content, "utf8");

  const total = result.reversedCount + result.copiedCount;
  console.log(
    `[reverse] ${result.reversedCount} defect hunk(s) reversed (after -> before, id + "-rev"), ` +
      `${result.copiedCount} benign hunk(s) copied unchanged`,
  );
  console.log(`[reverse] wrote ${options.outPath} (${total} records)`);
  console.log(
    "[reverse] before/after/label/evidence stay in ORIGINAL orientation: the oracle labeler still sees before = buggy, after = fixed.",
  );

  return 0;
}

// Guard so importing parseArgs (unit tests) never triggers a run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[reverse] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
