#!/usr/bin/env -S npx tsx
/**
 * Phase 0 spike CLI (SPEC §5 Fase 0): runs the three hunk serializers
 * against `datasets/hunks.jsonl` through a DecisionPort, and writes an H0
 * report. No TypeSafe API key exists yet, so the default mode auto-detects
 * replay fixtures and otherwise falls back to a meaningless dry run — see
 * README.md "Phase 0 spike" for the four modes.
 *
 * Usage:
 *   pnpm spike [--serializer <name|all>] [--limit N] [--batch-size N] [--mode live|record|replay|dry-run]
 *
 * Exit code: 0 on H0 PASS, 2 on H0 FAIL, 1 on a run error.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import { generateDryRunScript } from "../../src/application/spike/dry-run-script.js";
import {
  type HunkRecord,
  type HunkRecordLabel,
  parseHunkRecordsJsonl,
} from "../../src/application/spike/hunk-record.js";
import { buildSpikeReport, renderSpikeReportMarkdown } from "../../src/application/spike/report.js";
import { listSerializerNames } from "../../src/application/spike/serializers.js";
import { type HunkResult, runSpike } from "../../src/application/spike/spike-runner.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATASET_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/spike");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];

interface CliOptions {
  readonly serializer: string;
  readonly limit: number | null;
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
  let serializer = "all";
  let limit: number | null = null;
  let batchSize = 10;
  let mode: Mode | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--serializer":
        serializer = requireValue(argv, ++i, "--serializer");
        break;
      case "--limit": {
        const value = Number(requireValue(argv, ++i, "--limit"));
        if (!Number.isFinite(value) || value < 0)
          throw new Error(`--limit must be a non-negative number, got "${argv[i]}"`);
        limit = value;
        break;
      }
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

  return { serializer, limit, batchSize, mode };
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

function buildPort(mode: Mode, hunks: readonly HunkRecord[]): DecisionPort {
  switch (mode) {
    case "dry-run":
      return createFakeDecisionAdapter(generateDryRunScript(hunks, DRY_RUN_SEED));
    case "live": {
      if (!process.env.TYPESAFE_API_KEY) {
        throw new Error('mode "live" requires TYPESAFE_API_KEY to be set');
      }
      // Adapter owns its own retry loop; disable the SDK client's built-in
      // retry so requests aren't retried twice (see typesafe-decision-adapter.ts).
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

  const raw = await readFile(DATASET_PATH, "utf8");
  let hunks = parseHunkRecordsJsonl(raw);
  if (options.limit !== null) {
    hunks = hunks.slice(0, options.limit);
  }

  const serializerNames =
    options.serializer === "all" ? listSerializerNames() : [options.serializer];

  const port = buildPort(mode, hunks);
  const labelsByHunkId: Record<string, HunkRecordLabel> = {};
  for (const hunk of hunks) {
    labelsByHunkId[hunk.id] = hunk.label;
  }

  const resultsBySerializer: Record<string, HunkResult[]> = {};
  for (const serializerName of serializerNames) {
    console.log(
      `[spike] running serializer "${serializerName}" (${hunks.length} hunks, mode=${mode})...`,
    );
    const run = await runSpike({
      port,
      hunks,
      serializerName,
      batchSize: options.batchSize,
      onProgress: ({ completedBatches, totalBatches }) => {
        process.stdout.write(
          `\r[spike] ${serializerName}: batch ${completedBatches}/${totalBatches}`,
        );
      },
    });
    process.stdout.write("\n");
    if (run.failures.length > 0) {
      console.warn(
        `[spike] ${run.failures.length} hunk(s) failed for serializer "${serializerName}"`,
      );
    }
    resultsBySerializer[serializerName] = run.results;
  }

  const report = buildSpikeReport(resultsBySerializer, labelsByHunkId);
  const markdown = renderSpikeReportMarkdown(report);

  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(REPORTS_DIR, `spike-${timestamp}.json`);
  const mdPath = join(REPORTS_DIR, `spike-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[spike] wrote ${jsonPath}`);
  console.log(`[spike] wrote ${mdPath}`);

  return report.overallVerdict === "PASS" ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[spike] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
