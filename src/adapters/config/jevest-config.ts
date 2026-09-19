/**
 * Loads `.jevest.yml`, the per-repo pipeline config (SPEC §5 Fase 2:
 * "Configuración por archivo .jevest.yml... umbrales, tools, presupuesto").
 * Schema validated with zod. Thresholds reuse the exact
 * `ConfidencePolicyConfig` shape from `config/policies.yaml`
 * (stage -> risk -> {auto_min, confirm_min}), so `.jevest.yml` can carry
 * its own bands and feed `createConfidencePolicy` directly (NFR-13).
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { ConfidencePolicyConfig } from "../../domain/confidence-policy.js";
import type { SizeThresholds } from "../../domain/size.js";

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
  const raw = await readFile(filePath, "utf8");

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
