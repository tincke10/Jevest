#!/usr/bin/env -S npx tsx
/**
 * Finding-filter spike CLI (H1, SPEC §5 Fase 1a step 3/5): runs the filter
 * question set over a findings dataset, scored against each finding's own
 * `label.real` (line-overlap ground truth, produced by the reviewer
 * pipeline). Mirrors `scripts/spike/run.ts`'s mode structure.
 *
 * Usage:
 *   pnpm filter [--findings <path>] [--batch-size N] [--mode live|record|replay|dry-run]
 *              [--judge none|deepseek|claude-cli|dry-run] [--judge-mode record|replay]
 *              [--judge-concurrency N] [--label line-overlap|oracle]
 *
 * `--label` picks the ground truth. The default, `line-overlap`, is the
 * original heuristic (datasets/FINDINGS.md §2) and keeps every committed
 * number reproducible. `--label oracle` scores against `label.oracle.verdict`,
 * the fix-aware label (§10) written by `pnpm findings:label`; its `unknown`
 * findings are excluded from H1/H3/H6 while Jev and the judge still answer for
 * all of them, so the two label runs are directly comparable on the same
 * fixtures at zero extra cost. A record without `label.oracle` under
 * `--label oracle` stops the run with a message naming the labeling command.
 *
 * `--judge deepseek` (H6, SPEC FR-8.3) runs the LLM-judge baseline over
 * the same findings and scores it at Jev's best threshold; `--judge-mode
 * record` makes real DeepSeek API calls (DEEPSEEK_API_KEY, per-token
 * billed, resumable, fixtures under tests/fixtures/filter-judge-deepseek/),
 * `replay` (default) reads them back. `--judge claude-cli` is the earlier
 * subscription-billed judge, kept only to replay its partial fixture set
 * under tests/fixtures/filter-judge/ (rule of 2026-09-22: the Claude
 * subscription is reserved for reviews; every other LLM call goes through
 * DeepSeek). The two judges never share a fixtures dir because the fixture
 * key hashes the input only, not the model. `--judge dry-run` proves the
 * H6 path with seeded fake answers. The judge and Jev sides are
 * independent; the H1/H6/H3 command is
 *   DEEPSEEK_API_KEY=... pnpm filter --findings datasets/findings-thorough.jsonl \
 *       --mode replay --judge deepseek --judge-mode record
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
import OpenAI from "openai";
import { createFakeDecisionAdapter } from "../../src/adapters/fake-decision-adapter.js";
import { createClaudeCliFindingJudge } from "../../src/adapters/judges/claude-cli-finding-judge.js";
import { createDeepSeekFindingJudge } from "../../src/adapters/judges/deepseek-finding-judge.js";
import { createFakeFindingJudge } from "../../src/adapters/judges/fake-finding-judge.js";
import { createRecordedFindingJudge } from "../../src/adapters/judges/recorded-finding-judge.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { DEEPSEEK_BASE_URL } from "../../src/adapters/reviewers/deepseek-reviewer.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import { generateDryRunFilterScript } from "../../src/application/filter/dry-run-filter-script.js";
import { generateDryRunJudgeScript } from "../../src/application/filter/dry-run-judge-script.js";
import {
  type FilterLabelCounts,
  type FilterLabelSource,
  buildFilterReport,
  renderFilterReportMarkdown,
} from "../../src/application/filter/filter-report.js";
import { runFilter } from "../../src/application/filter/filter-runner.js";
import {
  type FindingRecord,
  parseFindingRecordsJsonl,
} from "../../src/application/filter/finding-record.js";
import { type JudgeRunResult, runJudge } from "../../src/application/filter/judge-runner.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";
import type { FindingJudgePort } from "../../src/domain/ports/finding-judge-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_FINDINGS_PATH = join(REPO_ROOT, "datasets/findings.jsonl");
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/filter");
const JUDGE_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/filter-judge");
const DEEPSEEK_JUDGE_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/filter-judge-deepseek");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DRY_RUN_SEED = 42;
// Same rate-limit backoff as scripts/findings/generate.ts: 60s, 4 attempts.
const JUDGE_RATE_LIMIT_MAX_ATTEMPTS = 4;
const JUDGE_RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_JUDGE_CONCURRENCY = 2;

type Mode = "live" | "record" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "record", "replay", "dry-run"];
type Judge = "none" | "deepseek" | "claude-cli" | "dry-run";
const JUDGES: readonly Judge[] = ["none", "deepseek", "claude-cli", "dry-run"];
type JudgeMode = "record" | "replay";
const JUDGE_MODES: readonly JudgeMode[] = ["record", "replay"];
const LABELS: readonly FilterLabelSource[] = ["line-overlap", "oracle"];

export interface CliOptions {
  readonly findingsPath: string;
  readonly batchSize: number;
  readonly mode: Mode | null;
  readonly judge: Judge;
  readonly judgeMode: JudgeMode;
  readonly judgeConcurrency: number;
  readonly label: FilterLabelSource;
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
  let judge: Judge = "none";
  let judgeMode: JudgeMode = "replay";
  let judgeConcurrency = DEFAULT_JUDGE_CONCURRENCY;
  let label: FilterLabelSource = "line-overlap";

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
      case "--judge": {
        const value = requireValue(argv, ++i, "--judge");
        if (!JUDGES.includes(value as Judge)) {
          throw new Error(`--judge must be one of ${JUDGES.join(", ")}, got "${value}"`);
        }
        judge = value as Judge;
        break;
      }
      case "--judge-mode": {
        const value = requireValue(argv, ++i, "--judge-mode");
        if (!JUDGE_MODES.includes(value as JudgeMode)) {
          throw new Error(`--judge-mode must be one of ${JUDGE_MODES.join(", ")}, got "${value}"`);
        }
        judgeMode = value as JudgeMode;
        break;
      }
      case "--judge-concurrency": {
        const raw = requireValue(argv, ++i, "--judge-concurrency");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`--judge-concurrency must be an integer >= 1, got "${raw}"`);
        }
        judgeConcurrency = value;
        break;
      }
      case "--label": {
        const value = requireValue(argv, ++i, "--label");
        if (!LABELS.includes(value as FilterLabelSource)) {
          throw new Error(`--label must be one of ${LABELS.join(", ")}, got "${value}"`);
        }
        label = value as FilterLabelSource;
        break;
      }
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  return { findingsPath, batchSize, mode, judge, judgeMode, judgeConcurrency, label };
}

/**
 * Ground truth for the run, plus the full label population so the report can
 * say what it excluded. Under `oracle`, `unknown` findings are simply not in
 * the map: buildFilterReport skips any result without a ground-truth entry, so
 * they never reach the sweep, the ECE or the judge scoring, while Jev and the
 * judge still answer for every finding (their fixtures are label-independent).
 */
export function groundTruthFromLabel(
  findings: readonly FindingRecord[],
  label: FilterLabelSource,
): { groundTruth: Record<string, boolean>; counts: FilterLabelCounts } {
  const groundTruth: Record<string, boolean> = {};
  const counts = { real: 0, noise: 0, unknown: 0 };

  for (const finding of findings) {
    if (label === "line-overlap") {
      groundTruth[finding.id] = finding.label.real;
      counts[finding.label.real ? "real" : "noise"] += 1;
      continue;
    }
    const oracle = finding.label.oracle;
    if (oracle === undefined) {
      // The labeler failed on this record (truncation, balance, rate limit):
      // it is unlabeled, which is exactly what `unknown` means — excluded,
      // counted. Only a file with no oracle label at all is the wrong file.
      counts.unknown += 1;
      continue;
    }
    counts[oracle.verdict] += 1;
    if (oracle.verdict !== "unknown") {
      groundTruth[finding.id] = oracle.verdict === "real";
    }
  }

  if (label === "oracle" && findings.length > 0 && counts.unknown === findings.length) {
    throw new Error(
      "no record has a label.oracle, so --label oracle cannot score this file. Run `pnpm findings:label --findings <in> --out <out> --labeler deepseek --mode record` first and point --findings at the output.",
    );
  }

  return { groundTruth, counts };
}

function buildJudge(judge: Judge, judgeMode: JudgeMode): FindingJudgePort | null {
  switch (judge) {
    case "none":
      return null;
    case "dry-run":
      return createFakeFindingJudge(generateDryRunJudgeScript(DRY_RUN_SEED));
    case "deepseek": {
      if (judgeMode === "replay") {
        return createRecordedFindingJudge({
          fixturesDir: DEEPSEEK_JUDGE_FIXTURES_DIR,
          mode: "replay",
        });
      }
      if (!process.env.DEEPSEEK_API_KEY) {
        throw new Error("--judge deepseek --judge-mode record requires DEEPSEEK_API_KEY to be set");
      }
      return createRecordedFindingJudge({
        fixturesDir: DEEPSEEK_JUDGE_FIXTURES_DIR,
        mode: "record",
        underlying: createDeepSeekFindingJudge({
          client: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL }),
        }),
      });
    }
    case "claude-cli":
      if (judgeMode === "replay") {
        return createRecordedFindingJudge({ fixturesDir: JUDGE_FIXTURES_DIR, mode: "replay" });
      }
      // No API key check on purpose: the claude-cli adapter strips
      // ANTHROPIC_API_KEY and bills the Claude subscription (SPEC §13).
      return createRecordedFindingJudge({
        fixturesDir: JUDGE_FIXTURES_DIR,
        mode: "record",
        underlying: createClaudeCliFindingJudge({}),
      });
  }
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
  const { groundTruth: realByFindingId, counts: labelCounts } = groundTruthFromLabel(
    findings,
    options.label,
  );
  const datasetVersion = findings[0]?.datasetVersion ?? 1;

  console.log(
    `[filter] ground truth: ${options.label} (${labelCounts.real} real, ${labelCounts.noise} noise${options.label === "oracle" ? `, ${labelCounts.unknown} unknown excluded` : ""})`,
  );

  const port = buildPort(mode, findings);
  const judgePort = buildJudge(options.judge, options.judgeMode);

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

  let judgeRun: JudgeRunResult | null = null;
  if (judgePort) {
    console.log(
      `[filter] judging ${findings.length} findings with judge=${options.judge} (judge-mode=${options.judgeMode}, concurrency=${options.judgeConcurrency})...`,
    );
    judgeRun = await runJudge({
      judge: judgePort,
      findings,
      hunkDiffsById,
      concurrency: options.judgeConcurrency,
      retry: { maxAttempts: JUDGE_RATE_LIMIT_MAX_ATTEMPTS, backoffMs: JUDGE_RATE_LIMIT_BACKOFF_MS },
      onProgress: ({ completed, total }) => {
        const line = `[filter] judge ${completed}/${total}`;
        process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
      },
    });
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    if (judgeRun.failures.length > 0) {
      console.warn(`[filter] ${judgeRun.failures.length} judge call(s) failed`);
      for (const failure of judgeRun.failures) {
        console.warn(`[filter]   ${failure.findingId}: ${failure.error}`);
      }
    }
    if (judgeRun.stoppedEarly) {
      console.warn(`[filter] judge STOPPED EARLY: ${judgeRun.stopReason}`);
    }
    console.log(
      `[filter] judge: ${judgeRun.totals.requests} call(s), $${judgeRun.totals.totalCostUsd.toFixed(4)} ` +
        `(${options.judge === "claude-cli" ? "nominal, subscription" : "real, per-token"}), wall time ${(judgeRun.totals.wallTimeMs / 1000).toFixed(1)}s`,
    );
  }

  const report = buildFilterReport(
    { results: run.results, failures: run.failures },
    realByFindingId,
    {
      datasetVersion,
      labelSource: options.label,
      labelCounts,
      ...(judgeRun
        ? {
            judgeRun: {
              provider: options.judge,
              results: judgeRun.results,
              failures: judgeRun.failures,
            },
          }
        : {}),
    },
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

// Guard so `import { parseArgs } from "./run.js"` (unit tests) never
// triggers a run: only run main() when this file is the executed entry point.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[filter] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
