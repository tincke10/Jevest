#!/usr/bin/env -S npx tsx
/**
 * Phase 1a findings generation CLI (SPEC §5 Fase 1a step 2). Reviews a
 * (optionally stratified-sampled) subset of `datasets/hunks.jsonl` with a
 * real LLM reviewer, labels each finding by line-overlap against the fix,
 * and appends the result to `datasets/findings.jsonl`.
 *
 * Usage:
 *   pnpm findings --provider anthropic|openai [--limit N] [--budget-usd N]
 *                 [--estimate] [--out path] [--record] [--seed N]
 *
 * `--estimate` never calls the reviewer model: it uses
 * `client.messages.countTokens` on a small sample (Anthropic only, since
 * OpenAI's SDK has no equivalent free token-counting endpoint) and prints a
 * conservative cost projection, then exits 0 without spending anything.
 *
 * `--limit N` takes a seeded, label-stratified sample (SPEC §13 "Corridas
 * con --limit nunca son evidencia") — same rule as scripts/spike/run.ts.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createAnthropicReviewer } from "../../src/adapters/reviewers/anthropic-reviewer.js";
import { createOpenAiReviewer } from "../../src/adapters/reviewers/openai-reviewer.js";
import { createRecordedReviewer } from "../../src/adapters/reviewers/recorded-reviewer.js";
import { estimateReviewCostUsd } from "../../src/application/findings/estimate-cost.js";
import { generateFindings } from "../../src/application/findings/generate-findings.js";
import {
  CLAUDE_OPUS_5_PRICING,
  type ModelPricing,
} from "../../src/application/findings/pricing.js";
import { summarizeFindings } from "../../src/application/findings/summary.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import type { HunkRecord } from "../../src/application/spike/hunk-record.js";
import { stratifiedSample } from "../../src/application/spike/stratified-sample.js";
import {
  type FindingRecord,
  parseFindingRecordsJsonl,
  stringifyFindingRecord,
} from "../../src/domain/finding.js";
import type { ReviewerPort } from "../../src/domain/ports/reviewer-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATASET_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/findings");
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/findings.jsonl");

const DEFAULT_BUDGET_USD = 5;
const DEFAULT_SAMPLE_SEED = 42;
const ESTIMATE_SAMPLE_SIZE = 3;
// No per-hunk output measurement is possible without calling the model;
// findings are short structured output, so this is a deliberately modest
// flat assumption, stated explicitly in the printed estimate.
const ASSUMED_OUTPUT_TOKENS_PER_HUNK = 150;

type Provider = "anthropic" | "openai";
const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

export interface CliOptions {
  readonly provider: Provider;
  readonly limit: number | null;
  readonly budgetUsd: number;
  readonly estimate: boolean;
  /** Output path override; null means the caller should use the default. */
  readonly out: string | null;
  readonly record: boolean;
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
  let provider: Provider | null = null;
  let limit: number | null = null;
  let budgetUsd = DEFAULT_BUDGET_USD;
  let estimate = false;
  let out: string | null = null;
  let record = false;
  let seed = DEFAULT_SAMPLE_SEED;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--provider": {
        const value = requireValue(argv, ++i, "--provider");
        if (!PROVIDERS.includes(value as Provider)) {
          throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}, got "${value}"`);
        }
        provider = value as Provider;
        break;
      }
      case "--limit": {
        const raw = requireValue(argv, ++i, "--limit");
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`--limit must be a non-negative number, got "${raw}"`);
        }
        limit = value;
        break;
      }
      case "--budget-usd": {
        const raw = requireValue(argv, ++i, "--budget-usd");
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--budget-usd must be a positive number, got "${raw}"`);
        }
        budgetUsd = value;
        break;
      }
      case "--estimate":
        estimate = true;
        break;
      case "--out":
        out = requireValue(argv, ++i, "--out");
        break;
      case "--record":
        record = true;
        break;
      case "--seed": {
        const raw = requireValue(argv, ++i, "--seed");
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new Error(`--seed must be a number, got "${raw}"`);
        }
        seed = value;
        break;
      }
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (!provider) {
    throw new Error('--provider is required (one of "anthropic", "openai")');
  }

  return { provider, limit, budgetUsd, estimate, out, record, seed };
}

function pricingFor(provider: Provider): ModelPricing {
  if (provider === "anthropic") {
    return CLAUDE_OPUS_5_PRICING;
  }
  // OpenAI's gpt-5.6-luna pricing isn't confirmed anywhere in this task's
  // sources (see docs/FINDINGS.md); rather than guess a number, cost is
  // reported as $0 and callers are warned loudly. Live OpenAI generation is
  // out of scope for this run per the task brief anyway.
  console.warn(
    "[findings] WARNING: no confirmed pricing for the OpenAI reviewer model; cost_usd will read 0 for this run.",
  );
  return { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
}

function buildReviewer(provider: Provider, record: boolean): ReviewerPort {
  let underlying: ReviewerPort;
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'provider "anthropic" requires resolvable credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile)',
      );
    }
    underlying = createAnthropicReviewer({ client: new Anthropic() });
  } else {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('provider "openai" requires OPENAI_API_KEY to be set');
    }
    underlying = createOpenAiReviewer({ client: new OpenAI() });
  }

  if (!record) {
    return underlying;
  }
  return createRecordedReviewer({ fixturesDir: FIXTURES_DIR, mode: "record", underlying });
}

async function runEstimate(hunks: readonly HunkRecord[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "--estimate requires ANTHROPIC_API_KEY (it only supports the anthropic provider)",
    );
  }
  const client = new Anthropic();
  const estimate = await estimateReviewCostUsd({
    client,
    hunks,
    sampleSize: Math.min(ESTIMATE_SAMPLE_SIZE, hunks.length),
    targetHunks: hunks.length,
    pricing: CLAUDE_OPUS_5_PRICING,
    assumedOutputTokensPerHunk: ASSUMED_OUTPUT_TOKENS_PER_HUNK,
  });

  console.log(
    `[findings] estimate: sampled ${estimate.sampleSize} hunk(s), ${hunks.length} hunks in the full dataset`,
  );
  console.log(
    `[findings] estimate: avg ${estimate.avgInputTokensPerHunk.toFixed(0)} input tokens/hunk`,
  );
  console.log(
    `[findings] estimate: ~$${estimate.estimatedTotalUsd.toFixed(4)} for ${estimate.targetHunks} hunks ` +
      `(conservative upper bound: ignores prompt-caching discount; assumes ${ASSUMED_OUTPUT_TOKENS_PER_HUNK} output tokens/hunk)`,
  );
  return 0;
}

async function writeFindingsAppendDedupe(
  path: string,
  newRecords: readonly FindingRecord[],
): Promise<number> {
  let existingIds = new Set<string>();
  try {
    const existing = await readFile(path, "utf8");
    existingIds = new Set(parseFindingRecordsJsonl(existing).map((r) => r.id));
  } catch {
    // No existing file yet — nothing to dedupe against.
  }

  const toAppend = newRecords.filter((r) => !existingIds.has(r.id));
  if (toAppend.length === 0) {
    return 0;
  }

  await mkdir(join(path, ".."), { recursive: true });
  const lines = `${toAppend.map(stringifyFindingRecord).join("\n")}\n`;
  await appendFile(path, lines, "utf8");
  return toAppend.length;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const raw = await readFile(DATASET_PATH, "utf8");
  const allHunks = parseHunkRecordsJsonl(raw);

  if (options.estimate) {
    return runEstimate(allHunks);
  }

  let hunks = allHunks;
  if (options.limit !== null) {
    hunks = stratifiedSample(hunks, { limit: options.limit, seed: options.seed });
    console.warn(
      `[findings] WARNING: --limit ${options.limit} is a smoke test (seed=${options.seed}), not evidence for H1.`,
    );
  }

  const reviewer = buildReviewer(options.provider, options.record);
  const pricing = pricingFor(options.provider);

  console.log(
    `[findings] reviewing ${hunks.length} hunk(s) with provider=${options.provider}, budget=$${options.budgetUsd}...`,
  );

  const result = await generateFindings({
    hunks,
    reviewer,
    provider: options.provider,
    pricing,
    budgetUsd: options.budgetUsd,
  });

  if (result.failures.length > 0) {
    console.warn(`[findings] ${result.failures.length} hunk(s) failed:`);
    for (const failure of result.failures) {
      console.warn(`[findings]   ${failure.hunkId}: ${failure.error}`);
    }
  }
  if (result.hunksSkippedByBudget > 0) {
    console.warn(
      `[findings] budget exhausted: ${result.hunksSkippedByBudget} hunk(s) never attempted`,
    );
  }

  const outPath = options.out ?? DEFAULT_OUT_PATH;
  const written = await writeFindingsAppendDedupe(outPath, result.records);
  console.log(
    `[findings] wrote ${written} new finding(s) to ${outPath} (${result.records.length - written} already present)`,
  );

  const defectByHunkId = new Map(hunks.map((h) => [h.id, h.label.defect] as const));
  const summary = summarizeFindings({
    records: result.records,
    hunksReviewed: result.hunksAttempted,
    defectByHunkId,
  });

  console.log("");
  console.log(`[findings] hunks attempted: ${result.hunksAttempted}`);
  console.log(`[findings] total run cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(
    `[findings] findings: ${summary.totalFindings} (real ${summary.realCount}, noise ${summary.noiseCount})`,
  );
  console.log(
    `[findings] % findings on benign hunks: ${summary.percentFindingsOnBenignHunks.toFixed(1)}%`,
  );
  console.log(
    `[findings] latency ms p50/p95/p99: ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.p99}`,
  );

  return 0;
}

// Guard so `import { parseArgs } from "./generate.js"` (unit tests) never
// triggers a live run: only run main() when this file is the executed entry
// point, not merely imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[findings] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
