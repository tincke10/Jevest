/**
 * Loads `.jevest.yml`, the per-repo pipeline config (SPEC §5 Fase 2:
 * "Configuración por archivo .jevest.yml... umbrales, tools, presupuesto").
 * Schema validated with zod. Thresholds are stage -> risk -> {autoMin,
 * confirmMin}, feeding `createConfidencePolicy` directly (NFR-13).
 *
 * `.jevest.yml` is a PARTIAL override, not a complete file: this always
 * loads `config/jevest.example.yml` as the defaults (the example file IS
 * the single source of truth for defaults, so there is no separate
 * hardcoded default object to drift out of sync with it), deep-merges
 * whatever `.jevest.yml` contains on top of it (missing or an empty file
 * both mean "no overrides at all"), and validates the MERGED result with
 * the schema below. (Three reviewer keys — `mode`, `model`,
 * `verifier.provider` — are left out of the example on purpose and
 * resolved from the provider by
 * {@link resolveReviewerDefaults}, so the defaults never combine into an
 * invalid config.) Plain objects are merged key by key recursively (so
 * `thresholds.triage.low` can be overridden without touching
 * `thresholds.triage.medium` or any other stage); arrays and scalars are
 * replaced wholesale by the override, never combined. Any other read
 * error (bad permissions, path is a directory, etc.) still throws — only
 * a missing file is a legitimate "no overrides" signal. An unknown key at
 * ANY level of `.jevest.yml` throws, naming its full dotted path (e.g.
 * `reviewer.mdoe`) and the closest known key when one is within edit
 * distance 2, as typo protection — a partial file's whole point is that
 * most keys are absent on purpose, so a real typo would otherwise silently
 * do nothing. Every object schema below is strict for that reason,
 * including the stage and risk names under `thresholds`. A key path that
 * 0.1 accepted and 1.0 renamed (`reviewer.verifierModel`,
 * `thresholds.merge_gate`, `auto_min`, ...) gets a targeted error naming
 * its new path instead of the generic one ({@link legacyKeyMessages}).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PROFILE_CHANGE_KINDS } from "../../domain/change-kind.js";
import {
  CONFIDENCE_RISK_LEVELS,
  CONFIDENCE_STAGES,
  type ConfidencePolicyConfig,
} from "../../domain/confidence-policy.js";
import type { SizeThresholds } from "../../domain/size.js";
import type { SpendCapConfig } from "../../domain/spend-cap.js";

const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, "../../../config/jevest.example.yml");

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
  .strictObject({
    autoMin: z.number().min(0).max(1),
    confirmMin: z.number().min(0).max(1),
  })
  .refine((t) => t.confirmMin <= t.autoMin, {
    message: "confirmMin must be <= autoMin",
  });

function strictKeys<K extends string, S extends z.ZodType>(
  keys: readonly K[],
  value: S,
): z.ZodObject<Record<K, S>, z.core.$strict> {
  return z.strictObject(Object.fromEntries(keys.map((k) => [k, value])) as Record<K, S>);
}

// Every stage and every risk level is required: the example file defines all
// of them and a partial `.jevest.yml` is deep-merged onto it, so a missing one
// can only come from a broken example file.
const thresholdsSchema = strictKeys(
  CONFIDENCE_STAGES,
  strictKeys(CONFIDENCE_RISK_LEVELS, thresholdSchema),
);

const sizeThresholdsSchema = z
  .strictObject({
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
// written in (any language code or name the model understands; "en" by
// default). It also localizes the check text and the label descriptions;
// label NAMES are fixed English (src/domain/labels.ts). `narrative` turns the per-PR narrator call on or off; left
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
// Code context for the per-hunk mode, under `reviewer.hunks` (opt-in, all
// default false; with all three off every prompt, schema and recorded-fixture
// key is byte-identical to before they existed):
// `fullFile` adds the hunk's whole file at the PR head to the reviewer input
// (windowed when large); `impactContext` adds the other code that
// references what the hunk changes (an rg search in the checkout); both
// need a checkout of the PR head and are skipped with a note without one.
// `requireEvidence` makes every finding cite the code that proves it and
// drops (to low-confidence/discarded) the findings whose quotes are not in
// the code. See src/application/pipeline/stages/code-context.ts.
const DEFAULT_REVIEW_LANGUAGE = "en";

// Review mode. "agentic" runs ONE read-only agent per PR in a checkout of
// the head (claude-cli only for now), then hard exclusions, the evidence
// check, an optional per-finding LLM verifier (`verifier`) and Jev's staged
// judge — see src/application/pipeline/stages/agentic-review.ts and
// agentic-judge.ts. "hunks" is the legacy per-hunk reviewer (0.1's only
// mode), byte-identical to before `mode` existed. `agentic` holds the
// agent's caps; defaults below.
//
// The 1.0 default rule (see resolveReviewerDefaults): `mode`, `model` and
// `verifier.provider` left unset follow the provider, so the defaults never form an
// invalid combination. The built-in provider is claude-cli, which resolves
// to the recommended stack (agentic, claude-opus-5-5 at effort xhigh, the
// claude-cli verifier on claude-sonnet-5 at effort medium). Any other
// provider resolves to hunks without a verifier, because agentic mode
// requires claude-cli: naming `provider: anthropic` alone must not turn into
// a config error. An explicit value always wins and is validated as before.
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
  effort: "xhigh" as AgentEffort,
};
const DEFAULT_VERIFIER = {
  model: "claude-sonnet-5",
  effort: "medium" as AgentEffort,
  maxTurns: 12,
  timeoutMs: 300_000,
};
const DEFAULT_HUNKS = { fullFile: false, impactContext: false, requireEvidence: false };
/** The agent's model when `reviewer.model` is unset in agentic mode (the measured stack). */
export const DEFAULT_AGENTIC_MODEL = "claude-opus-5-5";
/** `reviewer.model` when unset for anthropic, and for claude-cli in hunks mode: 0.1's default. */
export const DEFAULT_HUNKS_CLAUDE_MODEL = "claude-sonnet-5";

interface UnresolvedReviewerDefaults {
  readonly provider: ReviewerProvider;
  readonly mode?: ReviewerMode | undefined;
  readonly model?: string | undefined;
  readonly verifier?: VerifierProvider | undefined;
}

/**
 * The 1.0 default rule for the three reviewer keys that depend on each other
 * (see the comment above REVIEWER_MODES). Pure; explicit values pass through.
 * `model` stays undefined for openai/deepseek (no sensible default: the
 * schema reports it as required) and for provider "none" (no LLM).
 */
export function resolveReviewerDefaults(r: UnresolvedReviewerDefaults): {
  mode: ReviewerMode;
  model: string | undefined;
  verifier: VerifierProvider;
} {
  const mode = r.mode ?? (r.provider === "claude-cli" ? "agentic" : "hunks");
  const verifier = r.verifier ?? (mode === "agentic" ? "claude-cli" : "none");
  let model = r.model;
  if (model === undefined) {
    if (r.provider === "claude-cli") {
      model = mode === "agentic" ? DEFAULT_AGENTIC_MODEL : DEFAULT_HUNKS_CLAUDE_MODEL;
    } else if (r.provider === "anthropic") {
      model = DEFAULT_HUNKS_CLAUDE_MODEL;
    }
  }
  return { mode, model, verifier };
}

const agenticSchema = z
  .strictObject({
    maxTurns: z.number().int().positive().default(DEFAULT_AGENTIC.maxTurns),
    timeoutMs: z.number().int().positive().default(DEFAULT_AGENTIC.timeoutMs),
    effort: z.enum(AGENT_EFFORT_LEVELS).default(DEFAULT_AGENTIC.effort),
  })
  .default(DEFAULT_AGENTIC);

// The per-finding verifier (agentic mode only). `provider` unset = resolved
// from the mode (resolveReviewerDefaults); the rest always has a default, so
// tuning the model or a cap never switches the verifier on or off.
const verifierSchema = z
  .strictObject({
    provider: z.enum(VERIFIER_PROVIDERS).optional(),
    model: z.string().min(1).default(DEFAULT_VERIFIER.model),
    effort: z.enum(AGENT_EFFORT_LEVELS).default(DEFAULT_VERIFIER.effort),
    maxTurns: z.number().int().positive().default(DEFAULT_VERIFIER.maxTurns),
    timeoutMs: z.number().int().positive().default(DEFAULT_VERIFIER.timeoutMs),
  })
  .default(DEFAULT_VERIFIER);

const hunksSchema = z
  .strictObject({
    fullFile: z.boolean().default(false),
    impactContext: z.boolean().default(false),
    requireEvidence: z.boolean().default(false),
  })
  .default(DEFAULT_HUNKS);

const reviewerSchema = z
  .strictObject({
    provider: z.enum(REVIEWER_PROVIDERS),
    model: z.string().min(1).optional(),
    language: z.string().trim().min(1).default(DEFAULT_REVIEW_LANGUAGE),
    narrative: z.boolean().optional(),
    descriptionContext: z.boolean().optional(),
    // Unset = resolved from the provider (resolveReviewerDefaults).
    mode: z.enum(REVIEWER_MODES).optional(),
    agentic: agenticSchema,
    verifier: verifierSchema,
    hunks: hunksSchema,
  })
  .superRefine((raw, ctx) => {
    const r = {
      ...raw,
      ...resolveReviewerDefaults({ ...raw, verifier: raw.verifier.provider }),
    };
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
        path: ["verifier", "provider"],
        message:
          "reviewer.verifier.provider needs reviewer.mode: agentic (the per-hunk mode has no verifier); set mode: agentic or drop reviewer.verifier.provider",
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
  .strictObject({
    inlineComments: z.boolean().default(true),
  })
  .default({ inlineComments: true });

// Cumulative cap over the whole service (see src/domain/spend-cap.ts), as
// opposed to `budgetUsd`, which caps ONE run. Always present: a consumer
// that wants no cap sets a very high `usd` — there is deliberately no
// `enabled: false` switch, so the ledger issue still gets written and the
// spend stays visible either way.
const spendCapSchema = z
  .strictObject({
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
  .strictObject({
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
  .strictObject({
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
  .strictObject({
    reviewer: reviewerSchema,
    thresholds: thresholdsSchema,
    sizeThresholds: sizeThresholdsSchema,
    publish: publishSchema,
    budgetUsd: z.number().positive(),
    spendCap: spendCapSchema,
    maxHunks: z.number().int().positive(),
    // The hunk profile's change_kind choices (stage 2): anything else could never match.
    skipChangeKinds: z.array(z.enum(PROFILE_CHANGE_KINDS)).default(["rename-or-format"]),
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
    /** Language of the review narrative, the check text and the label descriptions: "en" (default), "es", "es-AR", ... */
    readonly language: string;
    /** Resolved: the explicit value, else true for any LLM provider and false for "none". */
    readonly narrative: boolean;
    /** Author context from the PR description for the reviewer; resolved like `narrative`. */
    readonly descriptionContext: boolean;
    /** "agentic" (one read-only agent per PR; claude-cli only; the default with claude-cli) or "hunks" (legacy per-hunk reviewer; the default with any other provider). */
    readonly mode: ReviewerMode;
    /** The agentic reviewer's caps (agentic mode only). */
    readonly agentic: {
      /** Default 60. */
      readonly maxTurns: number;
      /** Default 900000 (15 minutes). */
      readonly timeoutMs: number;
      /** The agent's `--effort`. Default "xhigh" (measured: high explored too little). */
      readonly effort: AgentEffort;
    };
    /** The per-finding LLM verifier (agentic mode only). */
    readonly verifier: {
      /** Resolved: "claude-cli" (the default in agentic mode) or "none" (always "none" in hunks mode). */
      readonly provider: VerifierProvider;
      /** Default "claude-sonnet-5". */
      readonly model: string;
      /** The verifier's `--effort`. Default "medium". */
      readonly effort: AgentEffort;
      /** Default 12. */
      readonly maxTurns: number;
      /** Default 300000 (5 minutes). */
      readonly timeoutMs: number;
    };
    /** Code context for the per-hunk reviewer (hunks mode only). */
    readonly hunks: {
      /** The hunk's full file at the PR head in the reviewer input (needs a checkout). Default false. */
      readonly fullFile: boolean;
      /** References to what the hunk changes, from the checkout, in the reviewer input. Default false. */
      readonly impactContext: boolean;
      /** Every finding must quote the code that proves it; unverified ones are not published. Default false. */
      readonly requireEvidence: boolean;
    };
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

/** Levenshtein distance, for the "did you mean" hint on an unknown key. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const MAX_HINT_DISTANCE = 2;

interface SchemaDef {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly shape?: Record<string, z.ZodType>;
  readonly valueType?: z.ZodType;
}

/**
 * The keys the object schema at `path` accepts, walking through `.default()`,
 * `.optional()` and records (any key under a record leads to its value
 * schema). Empty when the path does not lead to an object.
 */
function knownKeysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
  let current: z.ZodType | undefined = schema;
  let remaining = [...path];
  while (current !== undefined) {
    const def = current.def as unknown as SchemaDef;
    if (def.type === "default" || def.type === "optional" || def.type === "nullable") {
      current = def.innerType;
    } else if (remaining.length === 0) {
      return def.type === "object" ? Object.keys(def.shape ?? {}) : [];
    } else if (def.type === "object") {
      current = def.shape?.[String(remaining[0])];
      remaining = remaining.slice(1);
    } else if (def.type === "record") {
      current = def.valueType;
      remaining = remaining.slice(1);
    } else {
      return [];
    }
  }
  return [];
}

/**
 * One message per unknown key, e.g. "unknown config key `reviewer.mdoe`
 * (did you mean `reviewer.mode`?)", with the hint only when a known key at
 * the same level is within {@link MAX_HINT_DISTANCE}.
 */
function unknownKeyMessages(issues: readonly z.core.$ZodIssue[]): string[] {
  const messages: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const parent = issue.path.map(String);
    const known = knownKeysAt(jevestConfigSchema, issue.path);
    for (const key of issue.keys) {
      const dotted = [...parent, key].join(".");
      let best: { key: string; distance: number } | undefined;
      for (const candidate of known) {
        const distance = editDistance(key, candidate);
        if (distance <= MAX_HINT_DISTANCE && (best === undefined || distance < best.distance)) {
          best = { key: candidate, distance };
        }
      }
      const hint = best ? ` (did you mean \`${[...parent, best.key].join(".")}\`?)` : "";
      messages.push(`unknown config key \`${dotted}\`${hint}`);
    }
  }
  return messages;
}

const MIGRATING_HINT = "see docs/MIGRATING.md";

/** 0.1 reviewer key paths (dotted) that 1.0 moved, mapped to where they live now. */
const RENAMED_REVIEWER_KEYS: Readonly<Record<string, string>> = {
  "reviewer.verifierModel": "reviewer.verifier.model",
  "reviewer.verifierEffort": "reviewer.verifier.effort",
  "reviewer.agentic.verifierMaxTurns": "reviewer.verifier.maxTurns",
  "reviewer.agentic.verifierTimeoutMs": "reviewer.verifier.timeoutMs",
  "reviewer.fullFile": "reviewer.hunks.fullFile",
  "reviewer.impactContext": "reviewer.hunks.impactContext",
  "reviewer.requireEvidence": "reviewer.hunks.requireEvidence",
};

/** 0.1 snake_case threshold stage and band keys, mapped to their 1.0 camelCase names. */
const RENAMED_THRESHOLD_STAGES: Readonly<Record<string, string>> = {
  hunk_profile: "hunkProfile",
  finding_filter: "findingFilter",
  merge_gate: "mergeGate",
};
const RENAMED_THRESHOLD_BAND_KEYS: Readonly<Record<string, string>> = {
  auto_min: "autoMin",
  confirm_min: "confirmMin",
};

function renamedMessage(from: string, to: string): string {
  return `\`${from}\` was renamed to \`${to}\` in 1.0 — ${MIGRATING_HINT}`;
}

/**
 * Targeted errors for the key paths 0.1 accepted and 1.0 renamed, read off
 * the user's raw overrides (before the merge, so the example file's defaults
 * never trigger one). Empty when there is none. A 0.1 `reviewer.verifier`
 * is told apart from the 1.0 one by its shape: a string, not a mapping.
 */
function legacyKeyMessages(overrides: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const reviewer = overrides.reviewer;
  if (isPlainObject(reviewer)) {
    if (typeof reviewer.verifier === "string") {
      messages.push(renamedMessage("reviewer.verifier", "reviewer.verifier.provider"));
    }
    for (const [from, to] of Object.entries(RENAMED_REVIEWER_KEYS)) {
      const [, first = "", second] = from.split(".");
      const parent = second === undefined ? reviewer : reviewer[first];
      const key = second ?? first;
      if (isPlainObject(parent) && key in parent) messages.push(renamedMessage(from, to));
    }
  }
  const thresholds = overrides.thresholds;
  if (isPlainObject(thresholds)) {
    for (const [stage, risks] of Object.entries(thresholds)) {
      const newStage = RENAMED_THRESHOLD_STAGES[stage];
      if (newStage !== undefined) {
        messages.push(renamedMessage(`thresholds.${stage}`, `thresholds.${newStage}`));
      }
      if (!isPlainObject(risks)) continue;
      for (const [risk, band] of Object.entries(risks)) {
        if (!isPlainObject(band)) continue;
        for (const key of Object.keys(band)) {
          const newKey = RENAMED_THRESHOLD_BAND_KEYS[key];
          if (newKey === undefined) continue;
          messages.push(
            renamedMessage(
              `thresholds.${stage}.${risk}.${key}`,
              `thresholds.${newStage ?? stage}.${risk}.${newKey}`,
            ),
          );
        }
      }
    }
  }
  return messages;
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

  const legacy = legacyKeyMessages(overrides);
  if (legacy.length > 0) {
    throw new JevestConfigError(`${label}: ${legacy.join("; ")}`);
  }

  const merged = deepMerge(defaults, overrides);

  const result = jevestConfigSchema.safeParse(merged);
  if (!result.success) {
    const unknownKeys = unknownKeyMessages(result.error.issues);
    throw new JevestConfigError(
      `${label}: ${unknownKeys.length > 0 ? unknownKeys.join("; ") : result.error.message}`,
    );
  }

  const { reviewer } = result.data;
  const resolved = resolveReviewerDefaults({ ...reviewer, verifier: reviewer.verifier.provider });
  return {
    reviewer: {
      provider: result.data.reviewer.provider,
      model: resolved.model,
      language: result.data.reviewer.language,
      narrative: result.data.reviewer.narrative ?? result.data.reviewer.provider !== "none",
      descriptionContext:
        result.data.reviewer.descriptionContext ?? result.data.reviewer.provider !== "none",
      mode: resolved.mode,
      agentic: reviewer.agentic,
      verifier: { ...reviewer.verifier, provider: resolved.verifier },
      hunks: reviewer.hunks,
    },
    thresholds: result.data.thresholds,
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
 * from the PR BASE sha via the contents API instead of reading it off disk.
 */
export async function loadJevestConfigFromString(
  yaml: string,
  label = "<config>",
): Promise<JevestConfig> {
  return resolveJevestConfig(yaml, label);
}
