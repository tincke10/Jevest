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

const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, "../../../config/jevest.example.yml");

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "reviewer",
  "thresholds",
  "sizeThresholds",
  "publish",
  "budgetUsd",
  "maxHunks",
  "skipChangeKinds",
  "failClosed",
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
// required for "anthropic"/"openai" but meaningless (and omittable) for
// "none", enforced below with `superRefine` rather than a stricter type,
// since zod's `discriminatedUnion` would otherwise force every caller to
// narrow `config.reviewer` before reading `.model`.
const reviewerSchema = z
  .object({
    provider: z.enum(["anthropic", "openai", "none"]),
    model: z.string().min(1).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.provider !== "none" && !r.model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: `reviewer.model is required when reviewer.provider is "${r.provider}"`,
      });
    }
  });

const publishSchema = z
  .object({
    inlineComments: z.boolean().default(true),
  })
  .default({ inlineComments: true });

const jevestConfigSchema = z.object({
  reviewer: reviewerSchema,
  thresholds: z.record(z.string(), z.record(z.string(), thresholdSchema)),
  sizeThresholds: sizeThresholdsSchema,
  publish: publishSchema,
  budgetUsd: z.number().positive(),
  maxHunks: z.number().int().positive(),
  skipChangeKinds: z.array(z.string()).default(["rename-or-format"]),
  failClosed: z.boolean().default(true),
});

export interface JevestConfig {
  readonly reviewer: {
    readonly provider: "anthropic" | "openai" | "none";
    readonly model: string | undefined;
  };
  readonly thresholds: ConfidencePolicyConfig;
  readonly sizeThresholds: SizeThresholds;
  readonly publish: { readonly inlineComments: boolean };
  readonly budgetUsd: number;
  readonly maxHunks: number;
  readonly skipChangeKinds: readonly string[];
  readonly failClosed: boolean;
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

export async function loadJevestConfig(filePath: string): Promise<JevestConfig> {
  const defaultsRaw = await readFile(EXAMPLE_CONFIG_PATH, "utf8");
  const defaults = parse(defaultsRaw);

  let userRaw: string | null;
  try {
    userRaw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    userRaw = null;
  }

  let overrides: unknown = {};
  if (userRaw !== null) {
    let userParsed: unknown;
    try {
      userParsed = parse(userRaw);
    } catch (error) {
      throw new JevestConfigError(
        `${filePath}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // An empty file parses to null/undefined — that's "no overrides", not an error.
    if (userParsed !== null && userParsed !== undefined) {
      overrides = userParsed;
    }
  }

  if (!isPlainObject(overrides)) {
    throw new JevestConfigError(`${filePath} must be a mapping of config keys to values`);
  }

  for (const key of Object.keys(overrides)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new JevestConfigError(`${filePath}: unknown config key "${key}"`);
    }
  }

  const merged = deepMerge(defaults, overrides);

  const result = jevestConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new JevestConfigError(`${filePath}: ${result.error.message}`);
  }

  return {
    reviewer: { provider: result.data.reviewer.provider, model: result.data.reviewer.model },
    thresholds: toConfidencePolicyConfig(result.data.thresholds),
    sizeThresholds: result.data.sizeThresholds,
    publish: result.data.publish,
    budgetUsd: result.data.budgetUsd,
    maxHunks: result.data.maxHunks,
    skipChangeKinds: result.data.skipChangeKinds,
    failClosed: result.data.failClosed,
  };
}
