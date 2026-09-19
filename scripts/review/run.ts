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
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";
import { type JevestConfig, loadJevestConfig } from "../../src/adapters/config/jevest-config.js";
import { createRecordedDecisionAdapter } from "../../src/adapters/recorded-decision-adapter.js";
import { createAnthropicReviewer } from "../../src/adapters/reviewers/anthropic-reviewer.js";
import { createOpenAiReviewer } from "../../src/adapters/reviewers/openai-reviewer.js";
import { createRecordedReviewer } from "../../src/adapters/reviewers/recorded-reviewer.js";
import { createTypeSafeDecisionAdapter } from "../../src/adapters/typesafe-decision-adapter.js";
import {
  createGitFileContentFetcher,
  createLocalDiffVcsAdapter,
} from "../../src/adapters/vcs/local-diff-vcs-adapter.js";
import { runPipeline } from "../../src/application/pipeline/run-pipeline.js";
import type { Decision } from "../../src/domain/decision.js";
import type { DecisionPort } from "../../src/domain/ports/decision-port.js";
import type { ReviewerPort } from "../../src/domain/ports/reviewer-port.js";
import type { PullRequestRef } from "../../src/domain/pull-request.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, ".jevest.yml");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "reports/review");
const DECISION_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/review/decisions");
const REVIEW_FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures/review/reviews");

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

function buildReviewerPort(mode: Mode, config: JevestConfig): ReviewerPort {
  switch (mode) {
    case "dry-run":
      return createDryRunReviewer();
    case "live": {
      if (config.reviewer.provider === "anthropic") {
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error('reviewer.provider "anthropic" requires ANTHROPIC_API_KEY to be set');
        }
        const client = new Anthropic();
        return createAnthropicReviewer({ client, model: config.reviewer.model });
      }
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('reviewer.provider "openai" requires OPENAI_API_KEY to be set');
      }
      const client = new OpenAI();
      return createOpenAiReviewer({ client, model: config.reviewer.model });
    }
    case "replay":
      return createRecordedReviewer({ fixturesDir: REVIEW_FIXTURES_DIR, mode: "replay" });
  }
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
  const fetchFileContent = options.gitRange ? createGitFileContentFetcher(repoDir) : undefined;

  console.log(`[review] running pipeline (mode=${options.mode}, config=${options.configPath})...`);
  const result = await runPipeline({
    ref,
    ports: { vcs, decision, reviewer },
    config,
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
