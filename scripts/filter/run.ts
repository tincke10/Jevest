#!/usr/bin/env -S npx tsx
/**
 * Finding-filter spike CLI (H1, SPEC §5 Fase 1a step 3/5): runs the filter
 * question set over a findings dataset, scored against each finding's own
 * `label.real` (line-overlap ground truth, produced by the reviewer
 * pipeline). Mirrors `scripts/spike/run.ts`'s mode structure.
 *
 * Usage:
 *   pnpm filter [--findings <path>] [--batch-size N] [--mode live|record|replay|dry-run]
 *
 * `--batch-size` defaults to 1 (one finding per Jev request): batch
 * anchoring makes answers converge within a batch (SPEC NFR-14,
 * docs/analysis/h0-prime-error-analysis.md). Only raise it for cost
 * experiments, never as evidence.
 *
 * `datasets/findings.jsonl` does not exist yet as of this writing (the
 * reviewer pipeline produces it); point `--findings` at
 * `tests/fixtures/findings-synthetic.jsonl` for a smoke test in the
 * meantime. Exit code: 0 on H1 PASS, 2 on H1 FAIL, 1 on a run error.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import { generateDryRunFilterScript } from "../../src/application/filter/dry-run-filter-script.js";
import {
  buildFilterReport,
  renderFilterReportMarkdown,
} from "../../src/application/filter/filter-report.js";
import { runFilter } from "../../src/application/filter/filter-runner.js";
import {
  type FindingRecord,
  parseFindingRecordsJsonl,
} from "../../src/application/filter/finding-record.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_FINDINGS_PATH = join(REPO_ROOT, "datasets/findings.jsonl");
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/filter");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];

interface CliOptions {
  readonly findingsPath: string;
  readonly batchSize: number;
  readonly mode: Mode | null;
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
  let batchSize = 1;
  let mode: Mode | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--findings":
        findingsPath = requireValue(argv, ++i, "--findings");
        break;
      case "--batch-size": {
        const value = Number(requireValue(argv, ++i, "--batch-size"));
        if (!Number.isFinite(value) || value < 1)
          throw new Error(`--batch-size must be >= 1, got "${argv[i]}"`);
        batchSize = value;
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

  return { findingsPath, batchSize, mode };
}

async function resolveMode(requested: Mode | null): Promise<Mode> {
  if (requested) return requested;
  try {
    const entries = await readdir(FIXTURES_DIR);
    return entries.length > 0 ? "replay" : "dry-run";
  } catch {
    return "dry-run";
  }
}

function buildPort(mode: Mode, findings: readonly FindingRecord[]): DecisionPort {
  switch (mode) {
    case "dry-run":
      return createFakeDecisionAdapter(generateDryRunFilterScript(findings, DRY_RUN_SEED));
    case "live": {
      if (!process.env.TYPESAFE_API_KEY) {
        throw new Error('mode "live" requires TYPESAFE_API_KEY to be set');
      }
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      return createTypeSafeDecisionAdapter({ client });
    }
    case "record": {
      if (!process.env.TYPESAFE_API_KEY) {
        throw new Error('mode "record" requires TYPESAFE_API_KEY to be set');
      }
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      const underlying = createTypeSafeDecisionAdapter({ client });
      return createRecordedDecisionAdapter({
        fixturesDir: FIXTURES_DIR,
        mode: "record",
        underlying,
      });
    }
    case "replay":
      return createRecordedDecisionAdapter({ fixturesDir: FIXTURES_DIR, mode: "replay" });
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const mode = await resolveMode(options.mode);

  if (options.batchSize > 1) {
    console.warn(
      "[filter] WARNING: batch anchoring: answers within a batch converge; only use --batch-size > 1 for cost experiments.",
    );
  }

  const [findingsRaw, hunksRaw] = await Promise.all([
    readFile(options.findingsPath, "utf8"),
    readFile(HUNKS_PATH, "utf8"),
  ]);
  const findings = parseFindingRecordsJsonl(findingsRaw);
  const hunks = parseHunkRecordsJsonl(hunksRaw);

  const hunkDiffsById = new Map(hunks.map((h) => [h.id, h.diff]));
  const realByFindingId: Record<string, boolean> = {};
  for (const finding of findings) {
    realByFindingId[finding.id] = finding.label.real;
  }
  const datasetVersion = findings[0]?.datasetVersion ?? 1;

  const port = buildPort(mode, findings);

  console.log(`[filter] running ${findings.length} findings (mode=${mode})...`);
  const run = await runFilter({
    port,
    findings,
    hunkDiffsById,
    batchSize: options.batchSize,
    onProgress: ({ completedBatches, totalBatches }) => {
      const line = `[filter] batch ${completedBatches}/${totalBatches}`;
      process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
    },
  });
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  if (run.failures.length > 0) {
    console.warn(`[filter] ${run.failures.length} finding(s) failed`);
  }

  const report = buildFilterReport(
    { results: run.results, failures: run.failures },
    realByFindingId,
    { datasetVersion },
  );
  const markdown = renderFilterReportMarkdown(report);

  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(REPORTS_DIR, `filter-${timestamp}.json`);
  const mdPath = join(REPORTS_DIR, `filter-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[filter] wrote ${jsonPath}`);
  console.log(`[filter] wrote ${mdPath}`);

  return report.h1.verdict === "PASS" ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[filter] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
