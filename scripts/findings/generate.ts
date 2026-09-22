#!/usr/bin/env -S npx tsx
/**
 * Phase 1a findings generation CLI (SPEC §5 Fase 1a step 2). Reviews a
 * (optionally stratified-sampled) subset of `datasets/hunks.jsonl` with a
 * real LLM reviewer, labels each finding by line-overlap against the fix,
 * and appends the result to `datasets/findings.jsonl`.
 *
 * Usage:
 *   pnpm findings --provider anthropic|openai|deepseek|claude-cli [--limit N]
 *                 [--budget-usd N] [--estimate] [--out path] [--record]
 *                 [--seed N] [--concurrency N] [--prompt strict|thorough]
 *                 [--hunks path] [--fixtures-dir path]
 *
 * `--hunks` reviews a different hunks dataset, `datasets/hunks-reversed.jsonl`
 * in particular (H1b, datasets/FINDINGS.md §11): there the 50 defect hunks
 * carry a REVERSED diff, so the change under review introduces the bug the
 * real fix removed, and a real finding is one that flags it. A reversed hunk
 * is shown to the reviewer with the FIXED code as its pre-image and with its
 * own reversed `@@` header (see `reviewerViewOfHunk`), because that is what
 * sits before a fixed -> buggy change.
 *
 * `--fixtures-dir` overrides where `--record` writes. Reviewer fixtures are
 * keyed by the whole ReviewInput, so the reversed run's `-rev` ids and
 * reversed diffs already hash differently from the frozen originals; the flag
 * exists so a second dataset's fixtures can still be kept in their own
 * directory rather than mixed into the one a past run froze.
 *
 * `--estimate` never spends real per-token API money: for `anthropic`, it
 * uses `client.messages.countTokens` on a small sample (a free endpoint —
 * OpenAI has no equivalent, so `--estimate` isn't supported for it); for
 * `claude-cli`, there's no free token-counting endpoint at all, so it makes
 * 3 REAL calls (nominal subscription cost only, not cash) on a stratified
 * sample and extrapolates.
 *
 * `--limit N` takes a seeded, label-stratified sample (SPEC §13 "Corridas
 * con --limit nunca son evidencia") — same rule as scripts/spike/run.ts.
 *
 * `--concurrency N` (default 2, claude-cli only in practice — the Anthropic
 * and OpenAI adapters aren't run with more than 1 in this task) reviews
 * hunks in parallel via generateFindings's worker pool.
 *
 * `--prompt thorough` (default strict, unchanged behavior) swaps in the
 * low-bar REVIEW_SYSTEM_PROMPT_THOROUGH so the dataset gets enough noise to
 * evaluate the filter (SPEC §13, 2026-09-21). Thorough fixtures are recorded
 * under tests/fixtures/findings-thorough/ so they never collide with the
 * strict ones (the fixture key hashes the ReviewInput, not the prompt).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createAnthropicReviewer } from "../../src/adapters/reviewers/anthropic-reviewer.js";
import { createClaudeCliReviewer } from "../../src/adapters/reviewers/claude-cli-reviewer.js";
import {
  DEEPSEEK_BASE_URL,
  createDeepSeekReviewer,
} from "../../src/adapters/reviewers/deepseek-reviewer.js";
import { createOpenAiReviewer } from "../../src/adapters/reviewers/openai-reviewer.js";
import { createRecordedReviewer } from "../../src/adapters/reviewers/recorded-reviewer.js";
import { reviewSystemPromptFor } from "../../src/adapters/reviewers/review-prompt.js";
import { estimateClaudeCliCostUsd } from "../../src/application/findings/estimate-claude-cli-cost.js";
import { estimateReviewCostUsd } from "../../src/application/findings/estimate-cost.js";
import { generateFindings } from "../../src/application/findings/generate-findings.js";
import {
  CLAUDE_OPUS_5_PRICING,
  DEEPSEEK_V4_PRO_PRICING,
  type ModelPricing,
} from "../../src/application/findings/pricing.js";
import { summarizeFindings } from "../../src/application/findings/summary.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import type { HunkRecord } from "../../src/application/spike/hunk-record.js";
import { stratifiedSample } from "../../src/application/spike/stratified-sample.js";
import {
  type FindingRecord,
  type ReviewPromptMode,
  parseFindingRecordsJsonl,
  stringifyFindingRecord,
} from "../../src/domain/finding.js";
import type { ReviewerPort } from "../../src/domain/ports/reviewer-port.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATASET_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const FIXTURES_DIR_BY_PROMPT: Record<ReviewPromptMode, string> = {
  strict: join(REPO_ROOT, "tests/fixtures/findings"),
  thorough: join(REPO_ROOT, "tests/fixtures/findings-thorough"),
};
const DEFAULT_OUT_PATH = join(REPO_ROOT, "datasets/findings.jsonl");

const DEFAULT_BUDGET_USD = 5;
const DEFAULT_SAMPLE_SEED = 42;
const DEFAULT_CONCURRENCY = 2;
const ESTIMATE_SAMPLE_SIZE = 3;
// No per-hunk output measurement is possible without calling the model;
// findings are short structured output, so this is a deliberately modest
// flat assumption, stated explicitly in the printed estimate.
const ASSUMED_OUTPUT_TOKENS_PER_HUNK = 150;
// claude-cli backoff/retry on rate-limit / usage-limit signals (SPEC task
// brief): sleep 60s, retry up to 3 times (4 attempts total), then stop.
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 60_000;

type Provider = "anthropic" | "openai" | "deepseek" | "claude-cli";
const PROVIDERS: readonly Provider[] = ["anthropic", "openai", "deepseek", "claude-cli"];
const PROMPT_MODES: readonly ReviewPromptMode[] = ["strict", "thorough"];

export interface CliOptions {
  readonly provider: Provider;
  readonly limit: number | null;
  readonly budgetUsd: number;
  readonly estimate: boolean;
  /** Output path override; null means the caller should use the default. */
  readonly out: string | null;
  readonly record: boolean;
  readonly seed: number;
  readonly concurrency: number;
  readonly prompt: ReviewPromptMode;
  /** Hunks dataset override; null means `datasets/hunks.jsonl`. */
  readonly hunks: string | null;
  /** Reviewer-fixtures dir override; null means the prompt mode's default dir. */
  readonly fixturesDir: string | null;
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
  let concurrency = DEFAULT_CONCURRENCY;
  let prompt: ReviewPromptMode = "strict";
  let hunks: string | null = null;
  let fixturesDir: string | null = null;

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
      case "--concurrency": {
        const raw = requireValue(argv, ++i, "--concurrency");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`--concurrency must be an integer >= 1, got "${raw}"`);
        }
        concurrency = value;
        break;
      }
      case "--prompt": {
        const value = requireValue(argv, ++i, "--prompt");
        if (!PROMPT_MODES.includes(value as ReviewPromptMode)) {
          throw new Error(`--prompt must be one of ${PROMPT_MODES.join(", ")}, got "${value}"`);
        }
        prompt = value as ReviewPromptMode;
        break;
      }
      case "--hunks":
        hunks = requireValue(argv, ++i, "--hunks");
        break;
      case "--fixtures-dir":
        fixturesDir = requireValue(argv, ++i, "--fixtures-dir");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (!provider) {
    throw new Error(`--provider is required (one of ${PROVIDERS.map((p) => `"${p}"`).join(", ")})`);
  }

  return {
    provider,
    limit,
    budgetUsd,
    estimate,
    out,
    record,
    seed,
    concurrency,
    prompt,
    hunks,
    fixturesDir,
  };
}

function pricingFor(provider: Provider): ModelPricing {
  if (provider === "anthropic") {
    return CLAUDE_OPUS_5_PRICING;
  }
  if (provider === "deepseek") {
    return DEEPSEEK_V4_PRO_PRICING;
  }
  if (provider === "claude-cli") {
    // Never actually used for cost math: the claude-cli reviewer always
    // reports usage.nominalCostUsd, and generateFindings prefers that over
    // token-pricing (see generate-findings.ts). Kept as CLAUDE_OPUS_5_PRICING
    // — the same underlying model — purely as a sane fallback, never $0.
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

function buildReviewer(
  provider: Provider,
  record: boolean,
  promptMode: ReviewPromptMode,
  fixturesDir: string | null,
): ReviewerPort {
  const systemPrompt = reviewSystemPromptFor(promptMode);
  let underlying: ReviewerPort;
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'provider "anthropic" requires resolvable credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile)',
      );
    }
    underlying = createAnthropicReviewer({ client: new Anthropic(), systemPrompt });
  } else if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('provider "openai" requires OPENAI_API_KEY to be set');
    }
    underlying = createOpenAiReviewer({ client: new OpenAI(), systemPrompt });
  } else if (provider === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('provider "deepseek" requires DEEPSEEK_API_KEY to be set');
    }
    underlying = createDeepSeekReviewer({
      client: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL }),
      systemPrompt,
    });
  } else {
    // claude-cli: no API key check — it deliberately spawns `claude -p`
    // with ANTHROPIC_API_KEY stripped, drawing on the Claude Max
    // subscription's OAuth session instead (SPEC §13 2026-09-19 decision).
    underlying = createClaudeCliReviewer({ systemPrompt });
  }

  if (!record) {
    return underlying;
  }
  return createRecordedReviewer({
    fixturesDir: fixturesDir ?? FIXTURES_DIR_BY_PROMPT[promptMode],
    mode: "record",
    underlying,
  });
}

async function runAnthropicEstimate(hunks: readonly HunkRecord[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('--estimate for provider "anthropic" requires ANTHROPIC_API_KEY');
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

async function runClaudeCliEstimate(hunks: readonly HunkRecord[], seed: number): Promise<number> {
  const sample = stratifiedSample(hunks, { limit: ESTIMATE_SAMPLE_SIZE, seed });
  console.warn(
    `[findings] estimate: making ${sample.length} REAL claude-cli call(s) (nominal subscription cost, not cash)...`,
  );
  const reviewer = createClaudeCliReviewer({});
  const estimate = await estimateClaudeCliCostUsd({
    reviewer,
    hunks: sample,
    sampleSize: sample.length,
    targetHunks: hunks.length,
    seed,
  });

  console.log(
    `[findings] estimate: sampled ${estimate.sampleSize} hunk(s), ${hunks.length} hunks in the full dataset`,
  );
  console.log(
    `[findings] estimate: avg nominal cost $${estimate.avgNominalCostUsd.toFixed(4)}/hunk, avg wall time ${estimate.avgWallMs.toFixed(0)}ms/hunk`,
  );
  console.log(
    `[findings] estimate: ~$${estimate.estimatedTotalUsd.toFixed(2)} nominal for ${estimate.targetHunks} hunks, ~${(estimate.estimatedWallMsSerial / 1000 / 60).toFixed(1)} min serial (a concurrent run will be faster; nominal cost is subscription quota, not cash)`,
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

  const hunksPath = options.hunks ?? DATASET_PATH;
  const raw = await readFile(hunksPath, "utf8");
  const allHunks = parseHunkRecordsJsonl(raw);
  const reversedCount = allHunks.filter((h) => h.orientation === "reversed").length;
  if (reversedCount > 0) {
    console.log(
      `[findings] ${hunksPath}: ${reversedCount} of ${allHunks.length} hunk(s) are REVERSED (the diff introduces the bug the real fix removed, H1b).`,
    );
  }

  if (options.estimate) {
    if (options.provider === "anthropic") {
      return runAnthropicEstimate(allHunks);
    }
    if (options.provider === "claude-cli") {
      return runClaudeCliEstimate(allHunks, options.seed);
    }
    throw new Error(
      '--estimate is not supported for provider "openai" (no free token-counting endpoint)',
    );
  }

  let hunks = allHunks;
  if (options.limit !== null) {
    hunks = stratifiedSample(hunks, { limit: options.limit, seed: options.seed });
    console.warn(
      `[findings] WARNING: --limit ${options.limit} is a smoke test (seed=${options.seed}), not evidence for H1.`,
    );
  }

  const reviewer = buildReviewer(
    options.provider,
    options.record,
    options.prompt,
    options.fixturesDir,
  );
  const pricing = pricingFor(options.provider);

  console.log(
    `[findings] reviewing ${hunks.length} hunk(s) with provider=${options.provider}, prompt=${options.prompt}, ` +
      `budget=$${options.budgetUsd} (nominal for claude-cli), concurrency=${options.concurrency}...`,
  );

  const wallStart = Date.now();
  const result = await generateFindings({
    hunks,
    reviewer,
    provider: options.provider,
    pricing,
    budgetUsd: options.budgetUsd,
    concurrency: options.concurrency,
    // Rate-limit / usage-limit backoff applies to any provider that can
    // throw ReviewerRateLimitError; only claude-cli is expected to hit it
    // in practice (the task brief's explicit requirement).
    retry: { maxAttempts: RATE_LIMIT_MAX_ATTEMPTS, backoffMs: RATE_LIMIT_BACKOFF_MS },
    promptMode: options.prompt,
  });
  const wallMs = Date.now() - wallStart;

  if (result.failures.length > 0) {
    console.warn(`[findings] ${result.failures.length} hunk(s) failed:`);
    for (const failure of result.failures) {
      console.warn(`[findings]   ${failure.hunkId}: ${failure.error}`);
    }
  }
  if (result.hunksSkippedByBudget > 0) {
    const reason = result.stoppedEarly ? ` (${result.stopReason})` : " (budget exhausted)";
    console.warn(`[findings] ${result.hunksSkippedByBudget} hunk(s) never attempted${reason}`);
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

  const billingLabel = options.provider === "claude-cli" ? "nominal (subscription)" : "real (API)";

  console.log("");
  console.log(`[findings] hunks attempted: ${result.hunksAttempted}`);
  console.log(`[findings] wall time: ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`[findings] total run cost: $${result.totalCostUsd.toFixed(4)} (${billingLabel})`);
  console.log(
    `[findings] findings: ${summary.totalFindings} (real ${summary.realCount}, noise ${summary.noiseCount}), ` +
      `${summary.findingsPerHunk.toFixed(2)} findings/hunk`,
  );
  console.log(
    `[findings] by severity: nit ${summary.countsBySeverity.nit}, minor ${summary.countsBySeverity.minor}, ` +
      `major ${summary.countsBySeverity.major}, critical ${summary.countsBySeverity.critical}`,
  );
  console.log(
    `[findings] % findings on benign hunks: ${summary.percentFindingsOnBenignHunks.toFixed(1)}%`,
  );
  console.log(
    `[findings] latency ms p50/p95/p99: ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.p99}`,
  );
  console.log(`[findings] cache hit share: ${(summary.cacheHitShare * 100).toFixed(1)}%`);
  if (result.stoppedEarly) {
    console.warn(`[findings] STOPPED EARLY: ${result.stopReason}`);
  }

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
