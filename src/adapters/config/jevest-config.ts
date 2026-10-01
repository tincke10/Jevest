/**
 * Loads `.jevest.yml`, the per-repo pipeline config (SPEC §5 Fase 2:
 * "Configuración por archivo .jevest.yml... umbrales, tools, presupuesto").
 * Schema validated with zod. Thresholds are stage -> risk -> {auto_min,
 * confirm_min}, feeding `createConfidencePolicy` directly (NFR-13).
 *
 * `.jevest.yml` is a PARTIAL override, not a complete file: this always
 * loads `config/jevest.example.yml` as the defaults (the example file IS
 * the single source of truth for defaults, so there is no separate
 * hardcoded default object to drift out of sync with it), deep-merges
 * whatever `.jevest.yml` contains on top of it (missing or an empty file
 * both mean "no overrides at all"), and validates the MERGED result with
 * the schema below. Plain objects are merged key by key recursively (so
 * `thresholds.triage.low` can be overridden without touching
 * `thresholds.triage.medium` or any other stage); arrays and scalars are
 * replaced wholesale by the override, never combined. Any other read
 * error (bad permissions, path is a directory, etc.) still throws — only
 * a missing file is a legitimate "no overrides" signal. An unknown
 * top-level key in `.jevest.yml` throws immediately, naming the key, as
 * typo protection — a partial file's whole point is that most keys are
 * absent on purpose, so a real typo would otherwise silently do nothing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ConfidencePolicyConfig } from "../../domain/confidence-policy.js";
import type { SizeThresholds } from "../../domain/size.js";
import type { SpendCapConfig } from "../../domain/spend-cap.js";

const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, "../../../config/jevest.example.yml");

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "reviewer",
  "thresholds",
  "sizeThresholds",
  "publish",
  "budgetUsd",
  "spendCap",
  "maxHunks",
  "skipChangeKinds",
  "failClosed",
  "triage",
  "findingFilter",
]);

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively merges `override` onto `base`: a plain object merges key by
 * key (recursing when both sides are plain objects at that key), while an
 * array or scalar in `override` replaces whatever was at `base` entirely.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return merged;
  }
  return override;
}

export class JevestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevestConfigError";
  }
}

const thresholdSchema = z
  .object({
    auto_min: z.number().min(0).max(1),
    confirm_min: z.number().min(0).max(1),
  })
  .refine((t) => t.confirm_min <= t.auto_min, {
    message: "confirm_min must be <= auto_min",
  });

const sizeThresholdsSchema = z
  .object({
    smallMaxChangedLines: z.number().int().positive(),
    mediumMaxChangedLines: z.number().int().positive(),
  })
  .default({ smallMaxChangedLines: 50, mediumMaxChangedLines: 300 });

// "none" is Jev-only mode (SPEC §5 rollout decision): the review stage
// never runs and no LLM key is required — see run-pipeline.ts. `model` is
// required for "anthropic"/"openai"/"deepseek" but meaningless (and
// omittable) for "none", enforced below with `superRefine` rather than a
// stricter type, since zod's `discriminatedUnion` would otherwise force
// every caller to narrow `config.reviewer` before reading `.model`.
// "claude-cli" runs `claude -p` and bills a Claude subscription (Pro/Max)
// through a long-lived OAuth token from `claude setup-token`, instead of
// per-token API credits — see docs/ACTION.md "Claude subscription in CI".
export const REVIEWER_PROVIDERS = [
  "anthropic",
  "openai",
  "deepseek",
  "claude-cli",
  "none",
] as const;
export type ReviewerProvider = (typeof REVIEWER_PROVIDERS)[number];

// Colleague review: `language` is the language the review narrative is
// written in (any language code or name the model understands; "es" by
// default). `narrative` turns the per-PR narrator call on or off; left
// unset it follows the provider (on for any LLM, off for "none"), and an
// explicit `true` without an LLM is a config error, like
// `triage.changeSummary: always`. The narrator uses the reviewer's
// provider, model and credential.
//
// `descriptionContext` turns on the per-PR extractor that keeps the review-
// relevant part of the PR description (design decisions, intended behavior,
// scope, constraints, references) for the reviewer and drops every attempt
// to steer the review (src/application/pipeline/stages/description-context.ts).
// Same resolution as `narrative`: unset follows the provider, explicit
// `true` without an LLM is a config error.
//
// Code context (opt-in, all default false; with all three off every prompt,
// schema and recorded-fixture key is byte-identical to before they existed):
// `fullFile` adds the hunk's whole file at the PR head to the reviewer input
// (windowed when large); `impactContext` adds the other code that
// references what the hunk changes (an rg search in the checkout); both
// need a checkout of the PR head and are skipped with a note without one.
// `requireEvidence` makes every finding cite the code that proves it and
// drops (to low-confidence/discarded) the findings whose quotes are not in
// the code. See src/application/pipeline/stages/code-context.ts.
const DEFAULT_REVIEW_LANGUAGE = "es";

// Review mode. "hunks" (default) is the per-hunk reviewer every benchmark
// measured, byte-identical to before `mode` existed. "agentic" runs ONE
// read-only agent per PR in a checkout of the head (claude-cli only for
// now), then hard exclusions, the evidence check, an optional per-finding
// LLM verifier (`verifier`) and Jev's staged judge — see
// src/application/pipeline/stages/agentic-review.ts and agentic-judge.ts.
// `agentic` holds the agent's caps; defaults below.
export const REVIEWER_MODES = ["hunks", "agentic"] as const;
export type ReviewerMode = (typeof REVIEWER_MODES)[number];
export const VERIFIER_PROVIDERS = ["none", "claude-cli"] as const;
export type VerifierProvider = (typeof VERIFIER_PROVIDERS)[number];

// The claude CLI's `--effort` levels. Explicit because `--safe-mode` ignores
// the user's settings, so without the flag the agent runs at the CLI default.
export const AGENT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORT_LEVELS)[number];

const DEFAULT_AGENTIC = {
  maxTurns: 60,
  timeoutMs: 900_000,
  verifierMaxTurns: 12,
  verifierTimeoutMs: 300_000,
  effort: "xhigh" as AgentEffort,
};
const DEFAULT_VERIFIER_MODEL = "claude-sonnet-5";
const DEFAULT_VERIFIER_EFFORT: AgentEffort = "medium";

const agenticSchema = z
  .object({
    maxTurns: z.number().int().positive().default(DEFAULT_AGENTIC.maxTurns),
    timeoutMs: z.number().int().positive().default(DEFAULT_AGENTIC.timeoutMs),
    verifierMaxTurns: z.number().int().positive().default(DEFAULT_AGENTIC.verifierMaxTurns),
    verifierTimeoutMs: z.number().int().positive().default(DEFAULT_AGENTIC.verifierTimeoutMs),
    effort: z.enum(AGENT_EFFORT_LEVELS).default(DEFAULT_AGENTIC.effort),
  })
  .default(DEFAULT_AGENTIC);

const reviewerSchema = z
  .object({
    provider: z.enum(REVIEWER_PROVIDERS),
    model: z.string().min(1).optional(),
    language: z.string().trim().min(1).default(DEFAULT_REVIEW_LANGUAGE),
    narrative: z.boolean().optional(),
    descriptionContext: z.boolean().optional(),
    fullFile: z.boolean().default(false),
    impactContext: z.boolean().default(false),
    requireEvidence: z.boolean().default(false),
    mode: z.enum(REVIEWER_MODES).default("hunks"),
    agentic: agenticSchema,
    verifier: z.enum(VERIFIER_PROVIDERS).default("none"),
    verifierModel: z.string().min(1).default(DEFAULT_VERIFIER_MODEL),
    verifierEffort: z.enum(AGENT_EFFORT_LEVELS).default(DEFAULT_VERIFIER_EFFORT),
  })
  .superRefine((r, ctx) => {
    if (r.mode === "agentic" && r.provider !== "claude-cli") {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: `agentic mode currently requires reviewer.provider: claude-cli (got "${r.provider}")`,
      });
    }
    if (r.verifier !== "none" && r.mode !== "agentic") {
      ctx.addIssue({
        code: "custom",
        path: ["verifier"],
        message:
          "reviewer.verifier needs reviewer.mode: agentic (the per-hunk mode has no verifier); set mode: agentic or drop reviewer.verifier",
      });
    }
    if (r.provider !== "none" && !r.model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: `reviewer.model is required when reviewer.provider is "${r.provider}"`,
      });
    }
    if (r.provider === "none" && r.narrative === true) {
      ctx.addIssue({
        code: "custom",
        path: ["narrative"],
        message:
          'reviewer.narrative true needs an LLM to write the review: set reviewer.provider to something other than "none" (or drop reviewer.narrative)',
      });
    }
    if (r.provider === "none" && r.descriptionContext === true) {
      ctx.addIssue({
        code: "custom",
        path: ["descriptionContext"],
        message:
          'reviewer.descriptionContext true needs an LLM to read the PR description: set reviewer.provider to something other than "none" (or drop reviewer.descriptionContext)',
      });
    }
  });

const publishSchema = z
  .object({
    inlineComments: z.boolean().default(true),
  })
  .default({ inlineComments: true });

// Cumulative cap over the whole service (see src/domain/spend-cap.ts), as
// opposed to `budgetUsd`, which caps ONE run. Always present: a consumer
// that wants no cap sets a very high `usd` — there is deliberately no
// `enabled: false` switch, so the ledger issue still gets written and the
// spend stays visible either way.
const spendCapSchema = z
  .object({
    usd: z.number().positive(),
    period: z.enum(["month", "total"]),
    warnAtUsd: z.number().nonnegative(),
  })
  .refine((c) => c.warnAtUsd < c.usd, {
    path: ["warnAtUsd"],
    message: "spendCap.warnAtUsd must be < spendCap.usd",
  });

// Triage v2 (H7 adopted, SPEC §4.2): the product context file is read from
// the PR's BASE sha (see src/application/context/product-context.ts), and
// the change summary — one extra LLM call per PR, written without seeing
// the description — is "auto" (only when an LLM reviewer is configured),
// "always" (a summary is mandatory, so a provider must exist) or "never"
// (H7's without-summary arm: the description is judged against file facts
// only). The summarizer uses `reviewer.provider` / `reviewer.model`.
export const CHANGE_SUMMARY_MODES = ["auto", "always", "never"] as const;
export type ChangeSummaryMode = (typeof CHANGE_SUMMARY_MODES)[number];

const DEFAULT_PRODUCT_CONTEXT_PATH = ".jevest/context.yml";

const triageSchema = z
  .object({
    productContextPath: z.string().min(1).default(DEFAULT_PRODUCT_CONTEXT_PATH),
    changeSummary: z.enum(CHANGE_SUMMARY_MODES).default("auto"),
  })
  .default({ productContextPath: DEFAULT_PRODUCT_CONTEXT_PATH, changeSummary: "auto" });

// Product decision (2026-09-22, see docs/BENCHMARK.md "H1"): H1 found Jev's
// is_real_defect judgment near chance against the current labels (and the
// LLM-judge control equally near chance), so the label isn't trustworthy
// enough to discard findings on yet. "annotate" (default) never puts a
// finding in `discarded`: what would have been dropped is kept in a
// separate `lowConfidence` bucket instead, visible in the summary comment
// only (never inline, never affecting the merge gate). "discard" restores
// the original behavior — opt in only once H1 has a valid verdict.
export const FINDING_FILTER_MODES = ["annotate", "discard"] as const;
export type FindingFilterMode = (typeof FINDING_FILTER_MODES)[number];

/**
 * Where stage 4 gets its calibration map for `is_real_defect` (SPEC §4.6.3,
 * docs/BENCHMARK.md "Post-hoc calibration study"). "none" (the default) is the
 * identity: Jev's raw probability is used exactly as it always was. "file"
 * reads the map from `calibrationPath` in the consumer repo, at the PR's BASE
 * sha — same rule as `.jevest/context.yml` and `.jevest.yml`, since a map is a
 * knob that decides which findings get published and a PR must not be able to
 * rewrite it.
 *
 * The default stays "none" on purpose: the study's verdict is H3 FAIL
 * cross-set (a map fitted on one distribution carries an ECE of 0.216 to
 * another), so a calibration is something a consumer opts into for THEIR data,
 * never something that turns itself on.
 */
export const FINDING_FILTER_CALIBRATION_SOURCES = ["none", "file"] as const;
export type FindingFilterCalibrationSource = (typeof FINDING_FILTER_CALIBRATION_SOURCES)[number];

const DEFAULT_CALIBRATION_PATH = ".jevest/calibration.json";

const findingFilterSchema = z
  .object({
    mode: z.enum(FINDING_FILTER_MODES).default("annotate"),
    calibration: z.enum(FINDING_FILTER_CALIBRATION_SOURCES).default("none"),
    calibrationPath: z.string().min(1).default(DEFAULT_CALIBRATION_PATH),
  })
  .default({
    mode: "annotate",
    calibration: "none",
    calibrationPath: DEFAULT_CALIBRATION_PATH,
  });

const jevestConfigSchema = z
  .object({
    reviewer: reviewerSchema,
    thresholds: z.record(z.string(), z.record(z.string(), thresholdSchema)),
    sizeThresholds: sizeThresholdsSchema,
    publish: publishSchema,
    budgetUsd: z.number().positive(),
    spendCap: spendCapSchema,
    maxHunks: z.number().int().positive(),
    skipChangeKinds: z.array(z.string()).default(["rename-or-format"]),
    failClosed: z.boolean().default(true),
    triage: triageSchema,
    findingFilter: findingFilterSchema,
  })
  .superRefine((c, ctx) => {
    if (c.triage.changeSummary === "always" && c.reviewer.provider === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["triage", "changeSummary"],
        message:
          'triage.changeSummary "always" needs an LLM to write the summary: set reviewer.provider to something other than "none" (or use "auto"/"never")',
      });
    }
  });

export interface JevestConfig {
  readonly reviewer: {
    readonly provider: ReviewerProvider;
    readonly model: string | undefined;
    /** Language of the review narrative, e.g. "es" (default) or "en". */
    readonly language: string;
    /** Resolved: the explicit value, else true for any LLM provider and false for "none". */
    readonly narrative: boolean;
    /** Author context from the PR description for the reviewer; resolved like `narrative`. */
    readonly descriptionContext: boolean;
    /** The hunk's full file at the PR head in the reviewer input (needs a checkout). Default false. */
    readonly fullFile: boolean;
    /** References to what the hunk changes, from the checkout, in the reviewer input. Default false. */
    readonly impactContext: boolean;
    /** Every finding must quote the code that proves it; unverified ones are not published. Default false. */
    readonly requireEvidence: boolean;
    /** "hunks" (default, per-hunk reviewer) or "agentic" (one read-only agent per PR; claude-cli only). */
    readonly mode: ReviewerMode;
    /** The agentic reviewer's and verifier's caps (agentic mode only). */
    readonly agentic: {
      readonly maxTurns: number;
      readonly timeoutMs: number;
      readonly verifierMaxTurns: number;
      readonly verifierTimeoutMs: number;
      /** The agent's `--effort`. Default "xhigh" (measured: high explored too little). */
      readonly effort: AgentEffort;
    };
    /** Per-finding LLM verifier in agentic mode: "none" (default) or "claude-cli". */
    readonly verifier: VerifierProvider;
    /** The verifier's model. Default "claude-sonnet-5". */
    readonly verifierModel: string;
    /** The verifier's `--effort`. Default "medium". */
    readonly verifierEffort: AgentEffort;
  };
  readonly thresholds: ConfidencePolicyConfig;
  readonly sizeThresholds: SizeThresholds;
  readonly publish: { readonly inlineComments: boolean };
  readonly budgetUsd: number;
  readonly spendCap: SpendCapConfig;
  readonly maxHunks: number;
  readonly skipChangeKinds: readonly string[];
  readonly failClosed: boolean;
  readonly triage: {
    /** Repo-relative path of the product context file, read from the PR's base sha. */
    readonly productContextPath: string;
    readonly changeSummary: ChangeSummaryMode;
  };
  readonly findingFilter: {
    readonly mode: FindingFilterMode;
    /** "none" (default) = identity; "file" = read the map from `calibrationPath` at the PR's base sha. */
    readonly calibration: FindingFilterCalibrationSource;
    /** Repo-relative path of the calibration artifact; ignored when `calibration` is "none". */
    readonly calibrationPath: string;
  };
}

function toConfidencePolicyConfig(
  thresholds: Record<string, Record<string, { auto_min: number; confirm_min: number }>>,
): ConfidencePolicyConfig {
  const config: ConfidencePolicyConfig = {};
  for (const [stage, risks] of Object.entries(thresholds)) {
    const riskConfig: Record<string, { autoMin: number; confirmMin: number }> = {};
    for (const [risk, t] of Object.entries(risks)) {
      riskConfig[risk] = { autoMin: t.auto_min, confirmMin: t.confirm_min };
    }
    config[stage] = riskConfig;
  }
  return config;
}

/**
 * Shared by {@link loadJevestConfig} (reads `userRaw` off disk) and
 * {@link loadJevestConfigFromString} (caller already has the YAML text,
 * e.g. fetched from the GitHub contents API): everything past "get the
 * raw override text, or null for none" is identical — parse, merge onto
 * `config/jevest.example.yml`'s defaults, validate. `label` is only used
 * to name the source in error messages (a file path for the former, a
 * caller-supplied description like `"<owner>/<repo>@<sha>:.jevest.yml"`
 * for the latter).
 */
async function resolveJevestConfig(userRaw: string | null, label: string): Promise<JevestConfig> {
  const defaultsRaw = await readFile(EXAMPLE_CONFIG_PATH, "utf8");
  const defaults = parse(defaultsRaw);

  let overrides: unknown = {};
  if (userRaw !== null) {
    let userParsed: unknown;
    try {
      userParsed = parse(userRaw);
    } catch (error) {
      throw new JevestConfigError(
        `${label}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // An empty file parses to null/undefined — that's "no overrides", not an error.
    if (userParsed !== null && userParsed !== undefined) {
      overrides = userParsed;
    }
  }

  if (!isPlainObject(overrides)) {
    throw new JevestConfigError(`${label} must be a mapping of config keys to values`);
  }

  for (const key of Object.keys(overrides)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new JevestConfigError(`${label}: unknown config key "${key}"`);
    }
  }

  const merged = deepMerge(defaults, overrides);

  const result = jevestConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new JevestConfigError(`${label}: ${result.error.message}`);
  }

  return {
    reviewer: {
      provider: result.data.reviewer.provider,
      model: result.data.reviewer.model,
      language: result.data.reviewer.language,
      narrative: result.data.reviewer.narrative ?? result.data.reviewer.provider !== "none",
      descriptionContext:
        result.data.reviewer.descriptionContext ?? result.data.reviewer.provider !== "none",
      fullFile: result.data.reviewer.fullFile,
      impactContext: result.data.reviewer.impactContext,
      requireEvidence: result.data.reviewer.requireEvidence,
      mode: result.data.reviewer.mode,
      agentic: result.data.reviewer.agentic,
      verifier: result.data.reviewer.verifier,
      verifierModel: result.data.reviewer.verifierModel,
      verifierEffort: result.data.reviewer.verifierEffort,
    },
    thresholds: toConfidencePolicyConfig(result.data.thresholds),
    sizeThresholds: result.data.sizeThresholds,
    publish: result.data.publish,
    budgetUsd: result.data.budgetUsd,
    spendCap: result.data.spendCap,
    maxHunks: result.data.maxHunks,
    skipChangeKinds: result.data.skipChangeKinds,
    failClosed: result.data.failClosed,
    triage: result.data.triage,
    findingFilter: result.data.findingFilter,
  };
}

export async function loadJevestConfig(filePath: string): Promise<JevestConfig> {
  let userRaw: string | null;
  try {
    userRaw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    userRaw = null;
  }
  return resolveJevestConfig(userRaw, filePath);
}

/**
 * Same merge/validation as {@link loadJevestConfig}, but for YAML text the
 * caller already has in hand — the GitHub Action fetches `.jevest.yml`
 * from the PR head sha via the contents API when no local checkout is
 * present, instead of reading it off disk.
 */
export async function loadJevestConfigFromString(
  yaml: string,
  label = "<config>",
): Promise<JevestConfig> {
  return resolveJevestConfig(yaml, label);
}
