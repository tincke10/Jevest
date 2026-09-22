#!/usr/bin/env -S npx tsx
/**
 * Local review pipeline CLI (SPEC §5 Fase 1b): runs the six-stage pipeline
 * over a local unified diff (a file, or `git diff <base>..<head>` in the
 * current repo) and writes the result to `review.md`/`review.json` under
 * `--out` instead of talking to a real VCS.
 *
 * Usage:
 *   pnpm review --diff <file> [--config .jevest.yml] [--mode live|replay|dry-run] [--out reports/review/]
 *   pnpm review --git <base>..<head> [--config .jevest.yml] [--mode live|replay|dry-run] [--out reports/review/]
 *
 * `--mode dry-run` (the default) never calls a real Jev or LLM endpoint —
 * every question gets a plausible low-risk answer, and the reviewer always
 * returns no findings. Use it to smoke-test the CLI wiring. `--mode live`
 * requires `TYPESAFE_API_KEY` and the LLM provider's own API key
 * (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, matching `.jevest.yml`'s
 * `reviewer.provider`) per NFR-9. `--mode replay` reads recorded fixtures
 * from `tests/fixtures/review/` and throws a clear error on a miss.
 *
 * Triage v2 (H7): the change summarizer follows the same mode as the
 * reviewer (dry-run stub, recorded fixtures, or the live provider from
 * `.jevest.yml`), and the product context (`triage.productContextPath`)
 * is read from the BASE ref via `git show` in `--git` mode — the only mode
 * that has a base — and from the working tree in `--diff` mode.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";
import { type JevestConfig, loadJevestConfig } from "../../src/adapters/config/jevest-config.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createAnthropicReviewer } from "../../src/adapters/reviewers/anthropic-reviewer.js";
import { createClaudeCliReviewer } from "../../src/adapters/reviewers/claude-cli-reviewer.js";
import {
  DEEPSEEK_BASE_URL,
  createDeepSeekReviewer,
} from "../../src/adapters/reviewers/deepseek-reviewer.js";
import { createOpenAiReviewer } from "../../src/adapters/reviewers/openai-reviewer.js";
import { createRecordedReviewer } from "../../src/adapters/reviewers/recorded-reviewer.js";
import { createLocalFileSpendLedger } from "../../src/adapters/spend-ledger/local-file-spend-ledger.js";
import { createAnthropicSummarizer } from "../../src/adapters/summarizers/anthropic-summarizer.js";
import { createClaudeCliSummarizer } from "../../src/adapters/summarizers/claude-cli-summarizer.js";
import { createDeepSeekSummarizer } from "../../src/adapters/summarizers/deepseek-summarizer.js";
import { createOpenAiSummarizer } from "../../src/adapters/summarizers/openai-summarizer.js";
import { createRecordedSummarizer } from "../../src/adapters/summarizers/recorded-summarizer.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import {
  createGitFileContentFetcher,
  createLocalDiffVcsAdapter,
} from "../../src/adapters/vcs/local-diff-vcs-adapter.js";
import {
  type ProductContext,
  loadProductContext,
} from "../../src/application/context/product-context.js";
import { runPipeline } from "../../src/application/pipeline/run-pipeline.js";
import type { Decision } from "../../src/domain/decision.js";
import type { ChangeSummarizerPort } from "../../src/domain/ports/change-summarizer-port.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";
import type { ReviewerPort } from "../../src/domain/ports/reviewer-port.js";
import type { PullRequestRef } from "../../src/domain/pull-request.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, ".jevest.yml");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "reports/review");
const DECISION_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/review/decisions");
const REVIEW_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/review/reviews");
const SUMMARY_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/review/summaries");
/** Relative to the reviewed repo (cwd), git-ignored in this one. */
export const LOCAL_SPEND_LEDGER_PATH = ".jevest/spend-ledger.json";

type Mode = "live" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "replay", "dry-run"];

export interface CliOptions {
  readonly diffFile: string | null;
  readonly gitRange: { readonly base: string; readonly head: string } | null;
  readonly configPath: string;
  readonly mode: Mode;
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
  let diffFile: string | null = null;
  let gitRange: CliOptions["gitRange"] = null;
  let configPath = DEFAULT_CONFIG_PATH;
  let mode: Mode = "dry-run";
  let outDir = DEFAULT_OUT_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--diff":
        diffFile = requireValue(argv, ++i, "--diff");
        break;
      case "--git": {
        const value = requireValue(argv, ++i, "--git");
        const [base, head] = value.split("..").map((s) => s.trim());
        if (!base || !head) {
          throw new Error(`--git must be "<base>..<head>", got "${value}"`);
        }
        gitRange = { base, head };
        break;
      }
      case "--config":
        configPath = requireValue(argv, ++i, "--config");
        break;
      case "--mode": {
        const value = requireValue(argv, ++i, "--mode");
        if (!MODES.includes(value as Mode)) {
          throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${value}"`);
        }
        mode = value as Mode;
        break;
      }
      case "--out":
        outDir = requireValue(argv, ++i, "--out");
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (!diffFile && !gitRange) {
    throw new Error("exactly one of --diff <file> or --git <base>..<head> is required");
  }
  if (diffFile && gitRange) {
    throw new Error("--diff and --git are mutually exclusive");
  }

  return { diffFile, gitRange, configPath, mode, outDir };
}

/** Answers every question with a plausible low-risk pick — never calls a real Jev endpoint. */
function createDryRunDecisionPort(): DecisionPort {
  let counter = 0;
  return {
    async decide(_state, questions) {
      const answers: Record<string, Decision> = {};
      for (const [key, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          answers[key] = { type: "noul", noul: 0.05 };
        } else if (question.type === "choice") {
          const options = Object.keys(question.criteria);
          const pick = options[0];
          if (pick === undefined) {
            // validateQuestion guarantees 2..255 options; unreachable.
            continue;
          }
          const probabilities: Record<string, number> = {};
          const rest = Math.max(options.length - 1, 1);
          for (const option of options) probabilities[option] = option === pick ? 0.9 : 0.1 / rest;
          answers[key] = { type: "choice", choice: pick, probabilities, confidence: 0.9 };
        } else {
          const legend: Record<number, string> = {};
          const probabilities: Record<number, number> = {};
          question.criteria.forEach((label, index) => {
            legend[index] = label;
            probabilities[index] =
              index === 0 ? 0.9 : 0.1 / Math.max(question.criteria.length - 1, 1);
          });
          answers[key] = { type: "score", score: 0, legend, probabilities, confidence: 0.9 };
        }
      }
      counter += 1;
      return {
        requestId: `dry_${counter}`,
        model: "dry-run",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        // biome-ignore lint/suspicious/noExplicitAny: shape matches AnswersFor<Q> for every question actually asked, checked per-branch above.
        answers: answers as any,
      };
    },
  };
}

/** Never calls a real LLM — always reports no findings. */
function createDryRunReviewer(): ReviewerPort {
  return {
    async review() {
      return {
        findings: [],
        model: "dry-run",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 0,
        requestId: "dry-run",
      };
    },
  };
}

function buildDecisionPort(mode: Mode): DecisionPort {
  switch (mode) {
    case "dry-run":
      return createDryRunDecisionPort();
    case "live": {
      if (!process.env.TYPESAFE_API_KEY) {
        throw new Error('mode "live" requires TYPESAFE_API_KEY to be set');
      }
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      return createTypeSafeDecisionAdapter({ client });
    }
    case "replay":
      return createRecordedDecisionAdapter({ fixturesDir: DECISION_FIXTURES_DIR, mode: "replay" });
  }
}

/**
 * `undefined` means `reviewer.provider: "none"` (Jev-only mode) — the
 * pipeline never calls a reviewer in that case (see run-pipeline.ts), so
 * `--mode dry-run`/`live`/`replay` never need to build one either.
 */
function buildReviewerPort(mode: Mode, config: JevestConfig): ReviewerPort | undefined {
  if (config.reviewer.provider === "none") {
    return undefined;
  }
  switch (mode) {
    case "dry-run":
      return createDryRunReviewer();
    case "live": {
      const { model } = config.reviewer;
      if (model === undefined) {
        // jevest-config.ts's schema already requires this for "anthropic"/"openai"; defensive only.
        throw new Error(
          `.jevest.yml: reviewer.model is required when reviewer.provider is "${config.reviewer.provider}"`,
        );
      }
      switch (config.reviewer.provider) {
        case "anthropic":
          return createAnthropicReviewer({
            client: new Anthropic({ apiKey: requireLiveKey("anthropic") }),
            model,
          });
        case "deepseek":
          return createDeepSeekReviewer({
            client: new OpenAI({ apiKey: requireLiveKey("deepseek"), baseURL: DEEPSEEK_BASE_URL }),
            model,
          });
        case "claude-cli":
          requireLiveKey("claude-cli");
          return createClaudeCliReviewer({ model });
        default:
          return createOpenAiReviewer({
            client: new OpenAI({ apiKey: requireLiveKey("openai") }),
            model,
          });
      }
    }
    case "replay":
      return createRecordedReviewer({ fixturesDir: REVIEW_FIXTURES_DIR, mode: "replay" });
  }
}

const LIVE_KEY_ENV: Record<"anthropic" | "openai" | "deepseek" | "claude-cli", string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "claude-cli": "CLAUDE_CODE_OAUTH_TOKEN",
};

/** Same credential per provider for the reviewer and the summarizer (NFR-9). */
function requireLiveKey(provider: keyof typeof LIVE_KEY_ENV): string {
  const envVar = LIVE_KEY_ENV[provider];
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`reviewer.provider "${provider}" requires ${envVar} to be set`);
  }
  return value;
}

/** Never calls a real LLM — a fixed, plainly labeled summary at zero cost. */
function createDryRunSummarizer(): ChangeSummarizerPort {
  return {
    async summarize(input) {
      return {
        summary: {
          whatChanges: `Dry run: ${input.files.length} file(s) changed; no diff was read.`,
          behaviorChanges: [],
          userFacing: false,
          breaking: false,
          areas: [],
          risks: [],
        },
        model: "dry-run",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 0,
        requestId: "dry-run",
        nominalCostUsd: 0,
      };
    },
  };
}

/**
 * The summarizer for triage v2 (H7), following the reviewer's mode and
 * provider. `undefined` when `triage.changeSummary` is "never" or the
 * provider is "none" (Jev-only): run-pipeline.ts then runs triage in H7's
 * without-summary arm. Under "always" the config already guarantees a
 * provider, so a port is always returned here.
 */
function buildSummarizerPort(mode: Mode, config: JevestConfig): ChangeSummarizerPort | undefined {
  if (config.triage.changeSummary === "never" || config.reviewer.provider === "none") {
    return undefined;
  }
  switch (mode) {
    case "dry-run":
      return createDryRunSummarizer();
    case "live": {
      const { model } = config.reviewer;
      if (model === undefined) {
        throw new Error(
          `.jevest.yml: reviewer.model is required when reviewer.provider is "${config.reviewer.provider}"`,
        );
      }
      switch (config.reviewer.provider) {
        case "anthropic":
          return createAnthropicSummarizer({
            client: new Anthropic({ apiKey: requireLiveKey("anthropic") }),
            model,
          });
        case "deepseek":
          return createDeepSeekSummarizer({
            client: new OpenAI({ apiKey: requireLiveKey("deepseek"), baseURL: DEEPSEEK_BASE_URL }),
            model,
          });
        case "claude-cli":
          requireLiveKey("claude-cli");
          return createClaudeCliSummarizer({ model });
        default:
          return createOpenAiSummarizer({
            client: new OpenAI({ apiKey: requireLiveKey("openai") }),
            model,
          });
      }
    }
    case "replay":
      return createRecordedSummarizer({ fixturesDir: SUMMARY_FIXTURES_DIR, mode: "replay" });
  }
}

export interface LocalProductContextOptions {
  readonly repoDir: string;
  /** `triage.productContextPath` from the config, relative to `repoDir`. */
  readonly contextPath: string;
  readonly gitRange: CliOptions["gitRange"];
  /** Injectable for tests; default `createGitFileContentFetcher(repoDir)`. Used only in `--git` mode. */
  readonly fetchFileAt?: (path: string, sha: string) => Promise<string | null>;
}

/**
 * The product context for a local run. In `--git` mode it is read from the
 * BASE ref (`git show <base>:<path>`), the local counterpart of the
 * Action's base-sha fetch: the head must not judge itself. A plain diff
 * file has no base, so `--diff` mode reads the working tree and says so.
 */
export async function resolveLocalProductContext(
  options: LocalProductContextOptions,
): Promise<ProductContext> {
  if (options.gitRange) {
    const fetchFile = options.fetchFileAt ?? createGitFileContentFetcher(options.repoDir);
    return loadProductContext({
      fetchFile,
      path: options.contextPath,
      baseSha: options.gitRange.base,
      label: `${options.gitRange.base}:${options.contextPath}`,
    });
  }
  const filePath = join(options.repoDir, options.contextPath);
  return loadProductContext({
    fetchFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    path: filePath,
    baseSha: "<working tree>",
    label: filePath,
  });
}

/**
 * `.jevest.yml` is optional (loadJevestConfig itself falls back to
 * config/jevest.example.yml's built-in defaults when the path is missing);
 * this just also reports whether that fallback happened, so the CLI can
 * tell the user rather than silently running on defaults.
 */
export async function resolveConfig(
  configPath: string,
): Promise<{ config: JevestConfig; usedDefault: boolean }> {
  let usedDefault = false;
  try {
    await stat(configPath);
  } catch {
    usedDefault = true;
  }
  const config = await loadJevestConfig(configPath);
  return { config, usedDefault };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const { config, usedDefault } = await resolveConfig(options.configPath);
  if (usedDefault) {
    console.log("[review] no .jevest.yml found, using defaults");
  }
  const repoDir = process.cwd();

  const ref: PullRequestRef = {
    owner: "local",
    repo: "local",
    number: 0,
    headSha: options.gitRange?.head ?? "HEAD",
    baseSha: options.gitRange?.base ?? "base",
  };

  let source: Parameters<typeof createLocalDiffVcsAdapter>[0]["source"];
  if (options.diffFile) {
    source = { type: "file", path: options.diffFile };
  } else if (options.gitRange) {
    source = {
      type: "git-range",
      repoDir,
      base: options.gitRange.base,
      head: options.gitRange.head,
    };
  } else {
    // parseArgs guarantees exactly one of diffFile/gitRange is set; unreachable.
    throw new Error("internal: neither --diff nor --git was set");
  }

  const vcs = createLocalDiffVcsAdapter({
    source,
    outDir: options.outDir,
  });

  const decision = buildDecisionPort(options.mode);
  const reviewer = buildReviewerPort(options.mode, config);
  const summarizer = buildSummarizerPort(options.mode, config);
  const fetchFileContent = options.gitRange ? createGitFileContentFetcher(repoDir) : undefined;
  const productContext = await resolveLocalProductContext({
    repoDir,
    contextPath: config.triage.productContextPath,
    gitRange: options.gitRange,
  });
  if (productContext.areas.length === 0 && productContext.product === null) {
    console.log(`[review] no product context at ${config.triage.productContextPath}`);
  } else if (!options.gitRange) {
    console.log(
      `[review] product context read from the working tree (${config.triage.productContextPath}); --git mode reads it from the base ref instead`,
    );
  }
  // Local counterpart of the GitHub-issue ledger the Action uses: keeps
  // `spendCap` meaningful for `--mode live` runs against a real LLM. The
  // file is git-ignored; delete it to reset (see docs/ACTION.md "Spend cap").
  const spendLedger = createLocalFileSpendLedger({
    filePath: join(repoDir, LOCAL_SPEND_LEDGER_PATH),
  });

  console.log(`[review] running pipeline (mode=${options.mode}, config=${options.configPath})...`);
  const result = await runPipeline({
    ref,
    ports: {
      vcs,
      decision,
      spendLedger,
      ...(reviewer ? { reviewer } : {}),
      ...(summarizer ? { summarizer } : {}),
    },
    config,
    productContext,
    ...(fetchFileContent ? { fetchFileContent } : {}),
  });

  console.log("");
  console.log(result.publication.summaryMarkdown);
  console.log("");
  console.log(`[review] wrote ${join(options.outDir, "review.md")}`);
  console.log(`[review] wrote ${join(options.outDir, "review.json")}`);

  if (result.failedClosed) {
    console.error(`[review] failed closed at stage "${result.failureReason}" (NFR-2)`);
    return 1;
  }
  return 0;
}

// Guard so `import { parseArgs } from "./run.js"` (unit tests) never runs the CLI.
const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[review] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
