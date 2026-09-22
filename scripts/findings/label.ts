#!/usr/bin/env -S npx tsx
/**
 * Fix-aware oracle labeling CLI (datasets/FINDINGS.md §10). Reads a findings
 * dataset, asks the labeler two independent questions about each finding with
 * the FIX in hand, and writes the same records back with `label.oracle` added.
 *
 * Usage:
 *   pnpm findings:label --findings datasets/findings-thorough.jsonl \
 *                       --out datasets/findings-thorough-oracle.jsonl \
 *                       --labeler deepseek|dry-run --mode record|replay|dry-run \
 *                       [--concurrency N] [--model deepseek-v4-pro]
 *
 * Why this exists: the line-overlap label (§2) does not measure "is this
 * finding a real defect" — Jev and a DeepSeek reasoning judge both sit at
 * chance against it (FINDINGS.md §9), and the judge saw exactly what Jev saw.
 * The labeler here sees the code AFTER the fix, the fix's commit message and
 * the linked issue: information neither scored side ever had. That is what
 * makes it an independent label rather than a model grading itself.
 *
 * `--mode record` makes real DeepSeek calls (DEEPSEEK_API_KEY, per-token
 * billed, resumable — an existing fixture is served from disk and no call is
 * made), `replay` (the default) reads them back from
 * tests/fixtures/findings-oracle/, `dry-run` uses the seeded fake labeler and
 * spends nothing. A dry-run labeler in record mode is refused outright: it
 * would write seeded noise into a dataset field that reads as ground truth.
 *
 * The existing `label.real` line-overlap label is never touched, and neither
 * is `datasets/hunks.jsonl`. Scoring the filter against the new label is a
 * separate, zero-cost replay: `pnpm filter --label oracle`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { createDeepSeekFindingLabeler } from "../../src/adapters/labelers/deepseek-finding-labeler.js";
import { createFakeFindingLabeler } from "../../src/adapters/labelers/fake-finding-labeler.js";
import { createRecordedFindingLabeler } from "../../src/adapters/labelers/recorded-finding-labeler.js";
import { DEEPSEEK_BASE_URL } from "../../src/adapters/reviewers/deepseek-reviewer.js";
import {
  type FindingRecord,
  parseFindingRecordsJsonl,
  toOracleLabelWire,
} from "../../src/application/filter/finding-record.js";
import { generateDryRunLabelerScript } from "../../src/application/findings/dry-run-labeler-script.js";
import {
  type HunkEvidenceRecord,
  parseHunkEvidenceJsonl,
} from "../../src/application/findings/hunk-evidence.js";
import {
  type OracleLabelResult,
  runOracleLabeler,
} from "../../src/application/findings/oracle-label.js";
import {
  buildOracleReport,
  renderOracleReportMarkdown,
} from "../../src/application/findings/oracle-report.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import type { FindingLabelerPort } from "../../src/domain/ports/finding-labeler-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_FINDINGS_PATH = join(REPO_ROOT, "datasets/findings-thorough.jsonl");
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/findings-thorough-oracle.jsonl");
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const EVIDENCE_PATH = join(REPO_ROOT, "datasets/hunk-evidence.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/findings-oracle");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;
// Same rate-limit backoff as the judge runner: 60s, 4 attempts.
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MODEL = "deepseek-v4-pro";

type Labeler = "deepseek" | "dry-run";
const LABELERS: readonly Labeler[] = ["deepseek", "dry-run"];
type Mode = "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["record", "replay", "dry-run"];

export interface CliOptions {
  readonly findingsPath: string;
  readonly outPath: string;
  readonly labeler: Labeler;
  readonly mode: Mode;
  readonly concurrency: number;
  readonly model: string;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let findingsPath = DEFAULT_FINDINGS_PATH;
  let outPath = DEFAULT_OUT_PATH;
  let labeler: Labeler | null = null;
  let mode: Mode = "replay";
  let concurrency = DEFAULT_CONCURRENCY;
  let model = DEFAULT_MODEL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--findings":
        findingsPath = requireValue(argv, ++i, "--findings");
        break;
      case "--out":
        outPath = requireValue(argv, ++i, "--out");
        break;
      case "--labeler": {
        const value = requireValue(argv, ++i, "--labeler");
        if (!LABELERS.includes(value as Labeler)) {
          throw new Error(`--labeler must be one of ${LABELERS.join(", ")}, got "${value}"`);
        }
        labeler = value as Labeler;
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
      case "--concurrency": {
        const raw = requireValue(argv, ++i, "--concurrency");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`--concurrency must be an integer >= 1, got "${raw}"`);
        }
        concurrency = value;
        break;
      }
      case "--model":
        model = requireValue(argv, ++i, "--model");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (!labeler) {
    throw new Error(`--labeler is required (one of ${LABELERS.map((l) => `"${l}"`).join(", ")})`);
  }
  if (labeler === "dry-run" && mode === "record") {
    throw new Error(
      "the dry-run labeler cannot be used with --mode record: it would persist seeded noise as ground truth. Use --mode dry-run.",
    );
  }

  return { findingsPath, outPath, labeler, mode, concurrency, model };
}

function buildLabeler(options: CliOptions): FindingLabelerPort {
  if (options.labeler === "dry-run" || options.mode === "dry-run") {
    return createFakeFindingLabeler(generateDryRunLabelerScript(DRY_RUN_SEED));
  }
  if (options.mode === "replay") {
    return createRecordedFindingLabeler({ fixturesDir: FIXTURES_DIR, mode: "replay" });
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("--labeler deepseek --mode record requires DEEPSEEK_API_KEY to be set");
  }
  return createRecordedFindingLabeler({
    fixturesDir: FIXTURES_DIR,
    mode: "record",
    underlying: createDeepSeekFindingLabeler({
      client: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL }),
      model: options.model,
    }),
  });
}

/**
 * Injects `label.oracle` into one raw JSONL line, leaving everything else on
 * the record byte-identical. It works on the parsed JSON rather than on a
 * typed record on purpose: re-serializing from the typed record would silently
 * drop any field this file does not know about, and this dataset is written by
 * a different pipeline than the one that reads it.
 */
export function applyOracleLabelToLine(
  line: string,
  result: OracleLabelResult | undefined,
): string {
  if (result === undefined) return line;
  const record = JSON.parse(line) as { label?: Record<string, unknown> };
  const label = record.label ?? {};
  record.label = {
    ...label,
    oracle: toOracleLabelWire({
      verdict: result.verdict,
      source: "fix-oracle",
      labelerModel: result.labelerModel,
      fixMatch: result.fixMatch,
      claimVerification: result.claimVerification,
    }),
  };
  return JSON.stringify(record);
}

async function readEvidence(): Promise<Map<string, HunkEvidenceRecord>> {
  let raw: string;
  try {
    raw = await readFile(EVIDENCE_PATH, "utf8");
  } catch {
    console.warn(
      `[label] no ${EVIDENCE_PATH}; labeling from commit messages only. Run \`pnpm dataset:evidence\` to fetch issue and PR text.`,
    );
    return new Map();
  }
  return new Map(parseHunkEvidenceJsonl(raw).map((record) => [record.hunkId, record]));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const [findingsRaw, hunksRaw] = await Promise.all([
    readFile(options.findingsPath, "utf8"),
    readFile(HUNKS_PATH, "utf8"),
  ]);
  const findings: FindingRecord[] = parseFindingRecordsJsonl(findingsRaw);
  const hunksById = new Map(parseHunkRecordsJsonl(hunksRaw).map((hunk) => [hunk.id, hunk]));
  const evidenceByHunkId = await readEvidence();

  const withEvidence = findings.filter((f) => evidenceByHunkId.has(f.hunkId)).length;
  console.log(
    `[label] ${findings.length} findings, ${hunksById.size} hunks, ` +
      `${withEvidence} findings whose hunk has fetched issue/PR text ` +
      `(labeler=${options.labeler}, mode=${options.mode}, concurrency=${options.concurrency})`,
  );
  console.log(`[label] 2 calls per finding: ${findings.length * 2} total.`);

  const run = await runOracleLabeler({
    labeler: buildLabeler(options),
    findings,
    hunksById,
    evidenceByHunkId,
    concurrency: options.concurrency,
    retry: { maxAttempts: RATE_LIMIT_MAX_ATTEMPTS, backoffMs: RATE_LIMIT_BACKOFF_MS },
    onProgress: ({ completed, total }) => {
      const line = `[label] ${completed}/${total}`;
      process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
    },
  });
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }

  if (run.failures.length > 0) {
    console.warn(`[label] ${run.failures.length} finding(s) failed:`);
    for (const failure of run.failures.slice(0, 20)) {
      console.warn(`[label]   ${failure.findingId}: ${failure.error}`);
    }
  }
  if (run.stoppedEarly) {
    console.warn(`[label] STOPPED EARLY: ${run.stopReason}`);
  }

  const resultsById = new Map(run.results.map((result) => [result.findingId, result]));
  const outLines: string[] = [];
  let index = 0;
  for (const rawLine of findingsRaw.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const finding = findings[index];
    index += 1;
    outLines.push(
      applyOracleLabelToLine(trimmed, finding ? resultsById.get(finding.id) : undefined),
    );
  }
  await writeFile(options.outPath, `${outLines.join("\n")}\n`, "utf8");

  const report = buildOracleReport(run, findings);
  const markdown = renderOracleReportMarkdown(report);
  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mdPath = join(REPORTS_DIR, `oracle-${timestamp}.md`);
  const jsonPath = join(REPORTS_DIR, `oracle-${timestamp}.json`);
  await writeFile(mdPath, `${markdown}\n`, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[label] wrote ${options.outPath} (${outLines.length} records)`);
  console.log(`[label] wrote ${mdPath}`);
  console.log(`[label] wrote ${jsonPath}`);
  console.log(
    `[label] score the filter against it: pnpm filter --findings ${options.outPath} --mode replay --judge deepseek --judge-mode replay --label oracle`,
  );

  return run.stoppedEarly || run.failures.length > 0 ? 2 : 0;
}

// Guard so importing parseArgs (unit tests) never triggers a run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[label] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
