#!/usr/bin/env -S npx tsx
/**
 * Post-hoc calibration study for `is_real_defect` (H3, SPEC §4.2 / §4.6.3).
 *
 * H3 asks for ECE < 0.1 and Jev's raw probabilities miss it every time: 0.284
 * on the H1b reversed set (base rate 0.263), 0.504 on the thorough set (base
 * rate 0.028) — the answers run above the rate at which those findings are
 * actually real. This CLI asks the next question: can a monotone map fitted
 * after the fact fix the NUMBER without touching the RANKING (H1's recall
 * lives in the ranking, and no calibration is allowed to move it)?
 *
 * Usage:
 *   pnpm calibrate [--set <findings>:<hunks>]... [--findings <path> [--hunks <path>]]...
 *                  [--folds 5] [--seed N] [--primary <set-name>] [--emit <path>]
 *
 * With no arguments it runs both oracle-labeled sets — the H1b reversed set as
 * primary, the thorough set as the cross-set control — which is the command
 * docs/BENCHMARK.md's H3 section reproduces.
 *
 * Jev is REPLAY-ONLY here (tests/fixtures/filter/): a calibration study is a
 * re-reading of answers that already exist, so it costs nothing and a missing
 * fixture is a hard error naming the finding, never a live call. The ground
 * truth is always the fix-aware oracle label (`label.oracle`); `unknown` and
 * unlabeled findings are excluded exactly as `pnpm filter --label oracle`
 * excludes them.
 *
 * `--emit <path>` writes the winning map, fitted on ALL of the primary set's
 * points, as the artifact src/domain/calibration.ts parses (see
 * config/calibration/README.md for what a consumer should make of it).
 *
 * Exit code: 0 on H3 PASS (calibrated, held-out), 2 on FAIL, 1 on a run error
 * — same contract as `pnpm filter`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import type { CalibrationPoint } from "../../src/application/filter/calibration-fit.js";
import {
  type CalibrationSetInput,
  buildCalibrationStudy,
  renderCalibrationStudyMarkdown,
} from "../../src/application/filter/calibration-study.js";
import { runFilter } from "../../src/application/filter/filter-runner.js";
import { parseFindingRecordsJsonl } from "../../src/application/filter/finding-record.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import { renderCalibrationFile } from "../../src/domain/calibration.js";
import { groundTruthFromLabel } from "./run.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/filter");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const REVERSED_HUNKS_PATH = join(REPO_ROOT, "datasets/hunks-reversed.jsonl");

/** The H1b reversed set first (it is the primary one) and the thorough set as the control. */
const DEFAULT_FINDINGS_PATHS = [
  join(REPO_ROOT, "datasets/findings-reversed-oracle.jsonl"),
  join(REPO_ROOT, "datasets/findings-thorough-oracle.jsonl"),
];

export interface SetOption {
  readonly name: string;
  readonly findingsPath: string;
  readonly hunksPath: string;
}

export interface CliOptions {
  readonly sets: readonly SetOption[];
  readonly folds: number;
  readonly seed: number | null;
  /** Name of the set the verdict is computed on; null means "the first one". */
  readonly primarySet: string | null;
  readonly emitPath: string | null;
}

/**
 * Which hunks file a findings file was reviewed against. The H1b findings
 * point at `-rev` hunk ids that only exist in the reversed file, so getting
 * this wrong is not a subtle mismatch — the diff Jev was shown would simply
 * not be there.
 */
export function defaultHunksPathFor(findingsPath: string): string {
  return basename(findingsPath).includes("reversed") ? REVERSED_HUNKS_PATH : HUNKS_PATH;
}

/** Set name = the findings file's stem, suffixed if another set already took it. */
export function setNameFor(findingsPath: string, taken: readonly string[]): string {
  const stem = basename(findingsPath).replace(/\.jsonl$/, "");
  if (!taken.includes(stem)) return stem;
  let suffix = 2;
  while (taken.includes(`${stem}-${suffix}`)) suffix++;
  return `${stem}-${suffix}`;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const sets: { name: string; findingsPath: string; hunksPath: string }[] = [];
  let usedSetFlag = false;
  let usedFindingsFlag = false;
  let folds = 5;
  let seed: number | null = null;
  let primarySet: string | null = null;
  let emitPath: string | null = null;

  const push = (findingsPath: string, hunksPath: string): void => {
    sets.push({
      name: setNameFor(
        findingsPath,
        sets.map((s) => s.name),
      ),
      findingsPath,
      hunksPath,
    });
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--set": {
        if (usedFindingsFlag) {
          throw new Error("--set and --findings cannot be mixed: use one form or the other");
        }
        usedSetFlag = true;
        const value = requireValue(argv, ++i, "--set");
        const separator = value.lastIndexOf(":");
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error(`--set must be "<findings>:<hunks>", got "${value}"`);
        }
        push(value.slice(0, separator), value.slice(separator + 1));
        break;
      }
      case "--findings": {
        if (usedSetFlag) {
          throw new Error("--set and --findings cannot be mixed: use one form or the other");
        }
        usedFindingsFlag = true;
        const findingsPath = requireValue(argv, ++i, "--findings");
        push(findingsPath, defaultHunksPathFor(findingsPath));
        break;
      }
      case "--hunks": {
        const hunksPath = requireValue(argv, ++i, "--hunks");
        const current = sets[sets.length - 1];
        if (!current || usedSetFlag) {
          throw new Error("--hunks applies to the --findings before it; none was given");
        }
        current.hunksPath = hunksPath;
        break;
      }
      case "--folds": {
        const raw = requireValue(argv, ++i, "--folds");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 2) {
          throw new Error(`--folds must be an integer >= 2, got "${raw}"`);
        }
        folds = value;
        break;
      }
      case "--seed": {
        const raw = requireValue(argv, ++i, "--seed");
        const value = Number(raw);
        if (!Number.isInteger(value)) {
          throw new Error(`--seed must be an integer, got "${raw}"`);
        }
        seed = value;
        break;
      }
      case "--primary":
        primarySet = requireValue(argv, ++i, "--primary");
        break;
      case "--emit":
        emitPath = requireValue(argv, ++i, "--emit");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (sets.length === 0) {
    for (const findingsPath of DEFAULT_FINDINGS_PATHS) {
      push(findingsPath, defaultHunksPathFor(findingsPath));
    }
  }

  return { sets, folds, seed, primarySet, emitPath };
}

/**
 * Replays one set into labeled probabilities. Everything here mirrors `pnpm
 * filter --mode replay --label oracle`: the same fixtures, the same
 * `groundTruthFromLabel` exclusion of `unknown`, the same requirement that the
 * hunks file be the one the reviewer ran against. A Jev request that failed to
 * replay is a hard error, not a silently dropped point — a calibration fitted
 * on a subset nobody noticed is worse than no calibration.
 */
async function loadSet(option: SetOption): Promise<CalibrationSetInput> {
  const [findingsRaw, hunksRaw] = await Promise.all([
    readFile(option.findingsPath, "utf8"),
    readFile(option.hunksPath, "utf8"),
  ]);
  const findings = parseFindingRecordsJsonl(findingsRaw);
  const hunks = parseHunkRecordsJsonl(hunksRaw);
  const hunkDiffsById = new Map(hunks.map((h) => [h.id, h.diff]));
  const { groundTruth, counts } = groundTruthFromLabel(findings, "oracle");

  const port = createRecordedDecisionAdapter({ fixturesDir: FIXTURES_DIR, mode: "replay" });
  const run = await runFilter({ port, findings, hunkDiffsById, batchSize: 1 });
  if (run.failures.length > 0) {
    const [first] = run.failures;
    throw new Error(
      `${option.findingsPath}: ${run.failures.length} finding(s) could not be replayed from ${FIXTURES_DIR} ` +
        `(first: ${first?.findingId} — ${first?.error}). Record them with \`pnpm filter --findings ${option.findingsPath} --hunks ${option.hunksPath} --mode record\` first.`,
    );
  }

  const points: CalibrationPoint[] = [];
  for (const result of run.results) {
    const actual = groundTruth[result.findingId];
    if (actual === undefined) continue;
    points.push({ prob: result.isRealDefectProb, actual });
  }

  console.log(
    `[calibrate] ${option.name}: ${points.length} labeled point(s) from ${findings.length} finding(s) ` +
      `(${counts.real} real, ${counts.noise} noise, ${counts.unknown} unknown excluded)`,
  );

  return {
    name: option.name,
    // Repo-relative in the report: a committed number must not name whichever
    // laptop produced it.
    findingsPath: repoRelative(option.findingsPath),
    hunksPath: repoRelative(option.hunksPath),
    points,
  };
}

function repoRelative(path: string): string {
  const relativePath = relative(REPO_ROOT, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  console.log(
    `[calibrate] replaying ${options.sets.length} set(s) from ${FIXTURES_DIR} (no live calls, no cost)`,
  );
  const sets: CalibrationSetInput[] = [];
  for (const option of options.sets) {
    sets.push(await loadSet(option));
  }

  const study = buildCalibrationStudy(sets, {
    folds: options.folds,
    ...(options.seed === null ? {} : { seed: options.seed }),
    ...(options.primarySet === null ? {} : { primarySet: options.primarySet }),
  });
  const markdown = renderCalibrationStudyMarkdown(study);

  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = study.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(REPORTS_DIR, `calibration-${timestamp}.json`);
  const mdPath = join(REPORTS_DIR, `calibration-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(study, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  if (options.emitPath) {
    const primary = study.sets.find((s) => s.name === study.primarySet);
    const emitted = renderCalibrationFile(study.best.map, {
      source: primary?.findingsPath ?? study.primarySet,
      set: study.primarySet,
      fittedAt: study.generatedAt,
      fittedOn: primary?.count ?? 0,
      baseRate: Number((primary?.baseRate ?? 0).toFixed(4)),
      heldOutEce: Number(study.best.pooledEce.toFixed(4)),
      heldOutBrier: Number(study.best.pooledBrier.toFixed(4)),
      crossSetEce:
        study.best.worstCrossSetEce === null
          ? null
          : Number(study.best.worstCrossSetEce.toFixed(4)),
      rawEce: Number((primary?.rawEce ?? 0).toFixed(4)),
      verdict: study.verdict,
    });
    await writeFile(options.emitPath, emitted, "utf8");
    console.log(
      `[calibrate] wrote ${options.emitPath} (${study.best.method}, fitted on all points)`,
    );
  }

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[calibrate] wrote ${jsonPath}`);
  console.log(`[calibrate] wrote ${mdPath}`);

  return study.verdict === "PASS" ? 0 : 2;
}

// Same guard as scripts/filter/run.ts: importing parseArgs must never run main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[calibrate] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
