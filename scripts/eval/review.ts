#!/usr/bin/env -S npx tsx
/**
 * Eval harness CLI (docs/EVAL.md): scores one review variant against a
 * golden set and writes `<out>/<variant>/results.json` and `report.md`.
 *
 * Usage:
 *   pnpm eval:review --set <golden.jsonl> --variant <name> --out <dir>
 *     (--config <.jevest.yml> [--overrides <file.yml|json>] [--override key=value ...]
 *        [--mode live|replay|dry-run]
 *      | --import <dir with <caseId>.json>)
 *     [--matcher claude-cli|prefilter] [--matcher-model <model>] [--matcher-concurrency <n>]
 *     [--concurrency <n>]
 *     [--cases <id,id,...>]
 *
 * A pipeline variant runs the local review flow (scripts/review/run.ts,
 * `runLocalReview`) per case with `--git baseRef..headRef` inside the
 * case's `repoPath`; it publishes through the local-diff adapter only and
 * NEVER talks to GitHub. `--mode` defaults to dry-run, like `pnpm review`.
 * An import variant scores an existing review (e.g. a full-repo baseline).
 *
 * The matcher defaults to claude-cli (`claude -p`, the machine's Claude
 * login) with its decisions cached under `<out>/matcher-cache/`.
 * `--matcher prefilter` is deterministic and free, for smoke tests only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadJevestConfigFromString } from "../../src/adapters/config/jevest-config.js";
import { createCachedFindingMatcher } from "../../src/adapters/matchers/cached-finding-matcher.js";
import {
  CLAUDE_CLI_MATCHER_DEFAULT_MODEL,
  createClaudeCliFindingMatcher,
} from "../../src/adapters/matchers/claude-cli-finding-matcher.js";
import { candidatesFromImportedReview } from "../../src/application/eval/candidate.js";
import {
  applyConfigOverrides,
  parseOverride,
} from "../../src/application/eval/config-overrides.js";
import { renderEvalReport } from "../../src/application/eval/eval-report.js";
import { type CaseRun, type CaseSource, runEval } from "../../src/application/eval/eval-run.js";
import { type GoldenCase, parseGoldenSetJsonl } from "../../src/application/eval/golden-set.js";
import { createTopPrefilterMatcher } from "../../src/application/eval/match-candidates.js";
import { candidatesFromPipeline } from "../../src/application/eval/pipeline-candidates.js";
import type { FindingMatcherPort } from "../../src/domain/ports/finding-matcher-port.js";
import { runLocalReview } from "../review/run.js";

type Mode = "live" | "replay" | "dry-run";
const MODES: readonly Mode[] = ["live", "replay", "dry-run"];
type MatcherKind = "claude-cli" | "prefilter";
const MATCHERS: readonly MatcherKind[] = ["claude-cli", "prefilter"];
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type EvalSourceOptions =
  | {
      readonly type: "pipeline";
      readonly configPath: string;
      readonly overridesPath: string | null;
      readonly overrides: readonly string[];
      readonly mode: Mode;
    }
  | { readonly type: "import"; readonly dir: string };

export interface EvalCliOptions {
  readonly setPath: string;
  readonly variant: string;
  readonly outDir: string;
  readonly source: EvalSourceOptions;
  readonly matcher: MatcherKind;
  readonly matcherModel: string;
  readonly matcherConcurrency: number;
  /** Golden cases run in parallel (bounded pool); 1 = sequential. */
  readonly concurrency: number;
  readonly caseIds: readonly string[] | null;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`flag "${flag}" requires a value`);
  return value;
}

export function parseEvalArgs(argv: readonly string[]): EvalCliOptions {
  let setPath: string | null = null;
  let variant: string | null = null;
  let outDir: string | null = null;
  let configPath: string | null = null;
  let overridesPath: string | null = null;
  const overrides: string[] = [];
  let mode: Mode = "dry-run";
  let importDir: string | null = null;
  let matcher: MatcherKind = "claude-cli";
  let matcherModel = CLAUDE_CLI_MATCHER_DEFAULT_MODEL;
  let matcherConcurrency = 4;
  let concurrency = 1;
  let caseIds: string[] | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--set":
        setPath = requireValue(argv, ++i, arg);
        break;
      case "--variant":
        variant = requireValue(argv, ++i, arg);
        break;
      case "--out":
        outDir = requireValue(argv, ++i, arg);
        break;
      case "--config":
        configPath = requireValue(argv, ++i, arg);
        break;
      case "--overrides":
        overridesPath = requireValue(argv, ++i, arg);
        break;
      case "--override":
        overrides.push(requireValue(argv, ++i, arg));
        break;
      case "--mode": {
        const value = requireValue(argv, ++i, arg);
        if (!MODES.includes(value as Mode)) {
          throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${value}"`);
        }
        mode = value as Mode;
        break;
      }
      case "--import":
        importDir = requireValue(argv, ++i, arg);
        break;
      case "--matcher": {
        const value = requireValue(argv, ++i, arg);
        if (!MATCHERS.includes(value as MatcherKind)) {
          throw new Error(`--matcher must be one of ${MATCHERS.join(", ")}, got "${value}"`);
        }
        matcher = value as MatcherKind;
        break;
      }
      case "--matcher-model":
        matcherModel = requireValue(argv, ++i, arg);
        break;
      case "--matcher-concurrency": {
        const value = Number(requireValue(argv, ++i, arg));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--matcher-concurrency must be a positive integer");
        }
        matcherConcurrency = value;
        break;
      }
      case "--concurrency": {
        const value = Number(requireValue(argv, ++i, arg));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--concurrency must be a positive integer");
        }
        concurrency = value;
        break;
      }
      case "--cases":
        caseIds = requireValue(argv, ++i, arg)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }

  if (setPath === null) throw new Error("--set <golden.jsonl> is required");
  if (variant === null || !VARIANT_RE.test(variant)) {
    throw new Error("--variant <name> is required (letters, digits, '.', '_', '-')");
  }
  if (outDir === null) throw new Error("--out <dir> is required");
  if (configPath !== null && importDir !== null) {
    throw new Error("--config and --import are mutually exclusive");
  }
  let source: EvalSourceOptions;
  if (importDir !== null) {
    source = { type: "import", dir: importDir };
  } else if (configPath !== null) {
    source = { type: "pipeline", configPath, overridesPath, overrides, mode };
  } else {
    throw new Error("exactly one of --config <file> (pipeline) or --import <dir> is required");
  }
  return {
    setPath,
    variant,
    outDir,
    source,
    matcher,
    matcherModel,
    matcherConcurrency,
    concurrency,
    caseIds,
  };
}

/** `~` expands to the home directory; a relative path is relative to the set file's directory. */
export function resolveCasePath(path: string, setDir: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(setDir, path);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function importSource(dir: string): CaseSource {
  return async (goldenCase: GoldenCase): Promise<CaseRun> => {
    const path = join(dir, `${goldenCase.id}.json`);
    const raw = await readOptional(path);
    if (raw === null) throw new Error(`no imported review at ${path}`);
    const json = JSON.parse(raw) as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      caseId: goldenCase.id,
      candidates: candidatesFromImportedReview(json, goldenCase.id),
      costUsd: number(json.costUsd),
      tokens: number(json.tokens),
      wallTimeMs: number(json.wallTimeMs),
      error: null,
    };
  };
}

async function pipelineSource(
  options: Extract<EvalSourceOptions, { type: "pipeline" }>,
  variantDir: string,
  setDir: string,
  log: (line: string) => void,
): Promise<CaseSource> {
  const baseYaml = await readOptional(options.configPath);
  if (baseYaml === null)
    log(`[eval] ${options.configPath} not found: variant starts from the defaults`);
  const overridesRaw =
    options.overridesPath === null ? null : await readFile(options.overridesPath, "utf8");
  const yaml = applyConfigOverrides(
    baseYaml,
    overridesRaw === null ? undefined : parseYaml(overridesRaw),
    options.overrides.map(parseOverride),
  );
  const config = await loadJevestConfigFromString(yaml, `${options.configPath} (variant)`);
  await mkdir(variantDir, { recursive: true });
  await writeFile(join(variantDir, "config.yml"), yaml, "utf8");

  return async (goldenCase: GoldenCase): Promise<CaseRun> => {
    const caseDir = join(variantDir, "cases", goldenCase.id);
    const result = await runLocalReview({
      options: {
        diffFile: null,
        gitRange: { base: goldenCase.baseRef, head: goldenCase.headRef },
        mode: options.mode,
        outDir: caseDir,
      },
      config,
      configLabel: join(variantDir, "config.yml"),
      repoDir: resolveCasePath(goldenCase.repoPath, setDir),
      title: goldenCase.title,
      body: goldenCase.description,
      spendLedgerPath: join(variantDir, "spend-ledger.json"),
      log: (line) => log(`[${goldenCase.id}] ${line}`),
    });
    await writeFile(
      join(caseDir, "pipeline-result.json"),
      `${JSON.stringify(
        {
          failedClosed: result.failedClosed,
          failureReason: result.failureReason,
          costUsd: result.costUsd,
          findingsPublished: result.findingsPublished,
          findingsLowConfidence: result.findingsLowConfidence,
          metrics: result.metrics,
          // Per-hunk stats of the code-context layers (reviewer.fullFile /
          // impactContext), without the context text itself.
          codeContext:
            result.codeContext === null
              ? null
              : {
                  unavailable: result.codeContext.unavailable,
                  totals: result.codeContext.totals,
                  hunks: result.codeContext.hunks.map((h) => ({
                    hunkId: h.hunkId,
                    symbols: h.symbols,
                    matchesFound: h.matchesFound,
                    snippets: h.impactContext?.snippets.length ?? 0,
                    impactChars: h.impactContext?.chars ?? 0,
                    fullFileMode: h.fullFile?.mode ?? null,
                    fullFileChars: h.fullFile?.chars ?? 0,
                    error: h.error,
                  })),
                },
          // Agentic mode only: the agent's status, every tool call (the
          // read-only audit) and where each finding ended and why.
          ...(result.agentic
            ? {
                agentic: {
                  status: result.agentic.review.status,
                  error: result.agentic.review.error,
                  toolCalls: result.agentic.review.info?.toolCalls ?? [],
                  verifierToolCalls: result.agentic.judge?.verifierToolCalls ?? [],
                  findings: agenticFindingTrail(result),
                },
              }
            : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      caseId: goldenCase.id,
      candidates: candidatesFromPipeline(result, goldenCase.id),
      costUsd: result.costUsd,
      tokens: result.metrics.llm.tokens.spent,
      wallTimeMs: result.metrics.wallTime.totalMs,
      error: result.failedClosed ? `failed closed at stage "${result.failureReason}"` : null,
    };
  };
}

/** Each agentic finding's bucket, location, claim and route (why it landed there). */
function agenticFindingTrail(result: Awaited<ReturnType<typeof runLocalReview>>): unknown[] {
  const filter = result.findingFilter;
  if (filter === null) return [];
  const buckets = {
    published: filter.published,
    needsHuman: filter.needsHuman,
    lowConfidence: filter.lowConfidence,
    discarded: filter.discarded,
  };
  return Object.entries(buckets).flatMap(([bucket, findings]) =>
    findings.map((f) => ({
      bucket,
      id: f.findingId,
      file: f.file,
      line: f.lineStart,
      claim: f.claim,
      route: f.agentic?.route ?? f.rejectedReason ?? null,
      category: f.agentic?.category ?? null,
      reportedSeverity: f.agentic?.reportedSeverity ?? null,
      evidenceVerified: f.agentic?.evidenceVerified ?? null,
      verifier: f.agentic?.verifier ?? null,
      supports: f.agentic?.supports ?? null,
      mechanism: f.agentic?.mechanism ?? null,
      severity: f.agentic?.severity ?? null,
    })),
  );
}

function buildMatcher(options: EvalCliOptions): {
  matcher: FindingMatcherPort;
  info: Record<string, unknown>;
} {
  if (options.matcher === "prefilter") {
    return { matcher: createTopPrefilterMatcher(), info: { type: "prefilter" } };
  }
  return {
    matcher: createCachedFindingMatcher({
      inner: createClaudeCliFindingMatcher({ model: options.matcherModel }),
      dir: join(options.outDir, "matcher-cache"),
      model: options.matcherModel,
    }),
    info: { type: "claude-cli", model: options.matcherModel },
  };
}

export async function runEvalCli(
  options: EvalCliOptions,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const setDir = dirname(resolve(options.setPath));
  let cases = parseGoldenSetJsonl(await readFile(options.setPath, "utf8"));
  if (options.caseIds !== null) {
    const wanted = new Set(options.caseIds);
    const unknown = options.caseIds.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) throw new Error(`--cases: unknown case id(s) ${unknown.join(", ")}`);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  const variantDir = join(options.outDir, options.variant);
  const source =
    options.source.type === "import"
      ? importSource(resolveCasePath(options.source.dir, process.cwd()))
      : await pipelineSource(options.source, variantDir, setDir, log);
  const { matcher, info } = buildMatcher(options);

  const results = await runEval({
    variant: options.variant,
    setPath: options.setPath,
    cases,
    source,
    sourceInfo:
      options.source.type === "import"
        ? { type: "import", dir: options.source.dir }
        : {
            type: "pipeline",
            mode: options.source.mode,
            config: options.source.configPath,
            overridesFile: options.source.overridesPath,
            overrides: options.source.overrides,
          },
    matcher,
    matcherInfo: info,
    matcherConcurrency: options.matcherConcurrency,
    concurrency: options.concurrency,
    log,
  });

  await mkdir(variantDir, { recursive: true });
  await writeFile(
    join(variantDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  const report = renderEvalReport(results);
  await writeFile(join(variantDir, "report.md"), report, "utf8");
  log(report);
  log(`[eval] wrote ${join(variantDir, "results.json")} and report.md`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  runEvalCli(parseEvalArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("[eval] error:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
