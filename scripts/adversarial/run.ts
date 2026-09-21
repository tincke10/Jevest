#!/usr/bin/env -S npx tsx
/**
 * H5 adversarial suite CLI (SPEC §4.2 H5, NFR-7, §10 item 5): runs the
 * six-stage pipeline over every case in `datasets/adversarial/` with the
 * planted-finding fake reviewer and writes the H5 report. Mirrors
 * `scripts/coherence/run.ts`'s modes and flags.
 *
 * Usage:
 *   pnpm adversarial [--mode live|record|replay|dry-run] [--cases-dir <dir>] [--out <dir>]
 *
 * `--mode dry-run` (the default when no fixtures are recorded) answers with
 * a scripted, adversarial-aware fake: it proves the harness end to end and
 * is NOT evidence for H5. `record` needs TYPESAFE_API_KEY and writes Jev's
 * answers under tests/fixtures/adversarial/; `replay` reads them back (the
 * default once they exist) and is what CI enforces via
 * src/application/adversarial/adversarial-suite.test.ts.
 *
 * Unlike the H0'/H7 spikes, H5 is a regression gate (SPEC §10: "un PR
 * inyectado que consiga auto-merge verde rompe CI"): the process exits 1
 * when the verdict is FAIL or any secret leaked, in every mode.
 *
 * The pipeline config is the built-in defaults (config/jevest.example.yml),
 * never this repo's own `.jevest.yml` (which runs Jev-only, so the planted
 * finding would never be produced).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadJevestConfigFromString } from "../../src/adapters/config/jevest-config.js";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import { loadAdversarialCases } from "../../src/application/adversarial/adversarial-case.js";
import {
  buildAdversarialReport,
  renderAdversarialReportMarkdown,
} from "../../src/application/adversarial/adversarial-report.js";
import { runAdversarialSuite } from "../../src/application/adversarial/adversarial-runner.js";
import { generateDryRunAdversarialScript } from "../../src/application/adversarial/dry-run-adversarial-script.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_CASES_DIR = join(REPO_ROOT, "datasets/adversarial");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/adversarial");
const DEFAULT_REPORTS_DIR = join(REPO_ROOT, "reports");

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];

interface CliOptions {
  readonly mode: Mode | null;
  readonly casesDir: string;
  readonly outDir: string;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let mode: Mode | null = null;
  let casesDir = DEFAULT_CASES_DIR;
  let outDir = DEFAULT_REPORTS_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        const value = requireValue(argv, ++i, "--mode");
        if (!MODES.includes(value as Mode)) {
          throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${value}"`);
        }
        mode = value as Mode;
        break;
      }
      case "--cases-dir":
        casesDir = requireValue(argv, ++i, "--cases-dir");
        break;
      case "--out":
        outDir = requireValue(argv, ++i, "--out");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { mode, casesDir, outDir };
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

async function resolveMode(requested: Mode | null): Promise<Mode> {
  if (requested) return requested;
  return (await hasEntries(FIXTURES_DIR)) ? "replay" : "dry-run";
}

function requireApiKey(mode: Mode): void {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error(`mode "${mode}" requires TYPESAFE_API_KEY to be set`);
  }
}

function buildPort(mode: Mode): DecisionPort {
  switch (mode) {
    case "dry-run":
      return createFakeDecisionAdapter(generateDryRunAdversarialScript());
    case "live": {
      requireApiKey(mode);
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      return createTypeSafeDecisionAdapter({ client });
    }
    case "record": {
      requireApiKey(mode);
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
  const cases = await loadAdversarialCases(options.casesDir);
  const config = await loadJevestConfigFromString("", "<built-in defaults>");
  const port = buildPort(mode);

  console.log(`[adversarial] running ${cases.length} case(s), mode=${mode}...`);
  const run = await runAdversarialSuite({
    cases,
    decisionPort: port,
    config,
    onProgress: ({ completedCases, totalCases }) => {
      const line = `[adversarial] case ${completedCases}/${totalCases}`;
      process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
    },
  });
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }

  const report = buildAdversarialReport(run, { mode });
  const markdown = renderAdversarialReportMarkdown(report);

  await mkdir(options.outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(options.outDir, `adversarial-${timestamp}.json`);
  const mdPath = join(options.outDir, `adversarial-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`[adversarial] wrote ${jsonPath}`);
  console.log(`[adversarial] wrote ${mdPath}`);

  if (run.verdict === "FAIL" || run.totals.leaks > 0) {
    console.error(
      `[adversarial] H5 ${run.verdict}: ${run.totals.undueSuccesses} undue success(es), ${run.totals.suppressedCriticals} suppressed critical finding(s), ${run.totals.leaks} leak(s), ${run.totals.errors} error(s)`,
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[adversarial] error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
