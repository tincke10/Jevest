#!/usr/bin/env -S npx tsx
/**
 * Phase 0b surface-profile spike CLI (H0', SPEC §4.2, §5 Fase 0b): runs the
 * profile question set against `datasets/hunks.jsonl`, scored against AST
 * ground truth in `datasets/profile-labels.jsonl` (produced by
 * `pnpm profile:label`). Mirrors `scripts/spike/run.ts`'s modes and flags.
 *
 * Usage:
 *   pnpm spike:profile [--serializer <name|all>] [--limit N] [--seed N]
 *                       [--batch-size N] [--mode live|record|replay|dry-run]
 *
 * `--batch-size` defaults to 1 (one hunk per Jev request): batch anchoring
 * makes answers converge within a batch (SPEC NFR-14,
 * docs/analysis/h0-prime-error-analysis.md). Only raise it for cost
 * experiments, never as evidence.
 *
 * H0' is informative only (SPEC §4.2: "H0' no bloquea") — this CLI has no
 * pass/fail exit code semantics tied to phase progression; it always exits
 * 0 unless the run itself errors.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import { generateDryRunProfileScript } from "../../src/application/profile/dry-run-profile-script.js";
import type { ProfileLabels } from "../../src/application/profile/profile-label-record.js";
import { parseProfileLabelRecordsJsonl } from "../../src/application/profile/profile-label-record.js";
import {
  type ProfileSerializerRunResult,
  buildProfileReport,
  renderProfileReportMarkdown,
} from "../../src/application/profile/profile-report.js";
import { runProfileSpike } from "../../src/application/profile/profile-runner.js";
import { type HunkRecord, parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import { listSerializerNames } from "../../src/application/spike/serializers.js";
import { stratifiedSample } from "../../src/application/spike/stratified-sample.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const PROFILE_LABELS_PATH = join(REPO_ROOT, "datasets/profile-labels.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/spike-profile");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;
const DEFAULT_SAMPLE_SEED = 42;
const DEFAULT_SERIALIZER = "raw-diff";

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];

interface CliOptions {
  readonly serializer: string;
  readonly limit: number | null;
  readonly batchSize: number;
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
  let serializer = DEFAULT_SERIALIZER;
  let limit: number | null = null;
  let batchSize = 1;
  let mode: Mode | null = null;
  let seed = DEFAULT_SAMPLE_SEED;

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

  return { serializer, limit, batchSize, mode, seed };
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
      return createFakeDecisionAdapter(generateDryRunProfileScript(hunks, DRY_RUN_SEED));
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
      "[spike:profile] WARNING: batch anchoring: answers within a batch converge; only use --batch-size > 1 for cost experiments.",
    );
  }

  const [hunksRaw, labelsRaw] = await Promise.all([
    readFile(HUNKS_PATH, "utf8"),
    readFile(PROFILE_LABELS_PATH, "utf8"),
  ]);
  let hunks = parseHunkRecordsJsonl(hunksRaw);
  const labelRecords = parseProfileLabelRecordsJsonl(labelsRaw);
  const labelsByHunkId: Record<string, ProfileLabels> = {};
  for (const record of labelRecords) {
    labelsByHunkId[record.hunkId] = record.labels;
  }

  if (options.limit !== null) {
    hunks = stratifiedSample(hunks, { limit: options.limit, seed: options.seed });
    console.warn(
      `[spike:profile] WARNING: --limit ${options.limit} is a smoke test (seed=${options.seed}), not evidence for H0'.`,
    );
  }

  const serializerNames =
    options.serializer === "all" ? listSerializerNames() : [options.serializer];

  const port = buildPort(mode, hunks);
  const datasetVersion = hunks[0]?.datasetVersion ?? 1;

  const resultsBySerializer: Record<string, ProfileSerializerRunResult> = {};
  for (const serializerName of serializerNames) {
    console.log(
      `[spike:profile] running serializer "${serializerName}" (${hunks.length} hunks, mode=${mode})...`,
    );
    const run = await runProfileSpike({
      port,
      hunks,
      serializerName,
      batchSize: options.batchSize,
      onProgress: ({ completedBatches, totalBatches }) => {
        const line = `[spike:profile] ${serializerName}: batch ${completedBatches}/${totalBatches}`;
        process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
      },
    });
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    if (run.failures.length > 0) {
      console.warn(
        `[spike:profile] ${run.failures.length} hunk(s) failed for serializer "${serializerName}"`,
      );
    }
    resultsBySerializer[serializerName] = { results: run.results, failures: run.failures };
  }

  const report = buildProfileReport(resultsBySerializer, labelsByHunkId, { datasetVersion });
  const markdown = renderProfileReportMarkdown(report);

  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(REPORTS_DIR, `spike-profile-${timestamp}.json`);
  const mdPath = join(REPORTS_DIR, `spike-profile-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[spike:profile] wrote ${jsonPath}`);
  console.log(`[spike:profile] wrote ${mdPath}`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[spike:profile] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
