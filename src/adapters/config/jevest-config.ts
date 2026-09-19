/**
 * Loads `.jevest.yml`, the per-repo pipeline config (SPEC §5 Fase 2:
 * "Configuración por archivo .jevest.yml... umbrales, tools, presupuesto").
 * Schema validated with zod. Thresholds are stage -> risk -> {auto_min,
 * confirm_min}, feeding `createConfidencePolicy` directly (NFR-13).
 *
 * `.jevest.yml` is optional: when the given path does not exist (ENOENT),
 * this falls back to `config/jevest.example.yml` itself as the built-in
 * defaults — the example file IS the single source of truth for defaults,
 * so there is no separate hardcoded default object to drift out of sync
 * with it. Any other read error (bad permissions, path is a directory,
 * etc.) still throws — only a missing file is a legitimate "use defaults"
 * signal.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ConfidencePolicyConfig } from "../../domain/confidence-policy.js";
import type { SizeThresholds } from "../../domain/size.js";

const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, "../../../config/jevest.example.yml");

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

const jevestConfigSchema = z.object({
  reviewer: z.object({
    provider: z.enum(["anthropic", "openai"]),
    model: z.string().min(1),
  }),
  thresholds: z.record(z.string(), z.record(z.string(), thresholdSchema)),
  sizeThresholds: sizeThresholdsSchema,
  budgetUsd: z.number().positive(),
  maxHunks: z.number().int().positive(),
  skipChangeKinds: z.array(z.string()).default(["rename-or-format"]),
  failClosed: z.boolean().default(true),
});

export interface JevestConfig {
  readonly reviewer: { readonly provider: "anthropic" | "openai"; readonly model: string };
  readonly thresholds: ConfidencePolicyConfig;
  readonly sizeThresholds: SizeThresholds;
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
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    raw = await readFile(EXAMPLE_CONFIG_PATH, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new JevestConfigError(
      `${filePath}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const result = jevestConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new JevestConfigError(`${filePath}: ${result.error.message}`);
  }

  return {
    reviewer: result.data.reviewer,
    thresholds: toConfidencePolicyConfig(result.data.thresholds),
    sizeThresholds: result.data.sizeThresholds,
    budgetUsd: result.data.budgetUsd,
    maxHunks: result.data.maxHunks,
    skipChangeKinds: result.data.skipChangeKinds,
    failClosed: result.data.failClosed,
  };
}
