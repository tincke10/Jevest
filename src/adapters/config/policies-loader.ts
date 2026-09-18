/**
 * Loads confidence-band thresholds from `config/policies.yaml` into a
 * domain `ConfidencePolicyConfig` (NFR-13: thresholds live in versioned
 * configuration, never hardcoded).
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  ConfidencePolicyConfig,
  ConfidenceThresholds,
} from "../../domain/confidence-policy.js";

export class PoliciesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoliciesConfigError";
  }
}

export async function loadPoliciesConfig(filePath: string): Promise<ConfidencePolicyConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = parse(raw);
  return normalizeDocument(parsed, filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDocument(parsed: unknown, filePath: string): ConfidencePolicyConfig {
  if (!isPlainObject(parsed)) {
    throw new PoliciesConfigError(
      `policies config at ${filePath} must be a mapping of stage -> risk level -> thresholds`,
    );
  }

  const config: ConfidencePolicyConfig = {};
  for (const [stage, risks] of Object.entries(parsed)) {
    if (!isPlainObject(risks)) {
      throw new PoliciesConfigError(
        `stage "${stage}" in ${filePath} must map risk levels to thresholds`,
      );
    }

    const riskConfig: Record<string, ConfidenceThresholds> = {};
    for (const [risk, thresholds] of Object.entries(risks)) {
      riskConfig[risk] = normalizeThresholds(stage, risk, thresholds, filePath);
    }
    config[stage] = riskConfig;
  }

  return config;
}

function normalizeThresholds(
  stage: string,
  risk: string,
  thresholds: unknown,
  filePath: string,
): ConfidenceThresholds {
  if (!isPlainObject(thresholds)) {
    throw new PoliciesConfigError(
      `thresholds for "${stage}.${risk}" in ${filePath} must be an object with auto_min and confirm_min`,
    );
  }

  const { auto_min: autoMin, confirm_min: confirmMin } = thresholds;
  if (typeof autoMin !== "number" || typeof confirmMin !== "number") {
    throw new PoliciesConfigError(
      `thresholds for "${stage}.${risk}" in ${filePath} must have numeric "auto_min" and "confirm_min"`,
    );
  }
  if (confirmMin > autoMin) {
    throw new PoliciesConfigError(
      `thresholds for "${stage}.${risk}" in ${filePath}: "confirm_min" (${confirmMin}) must be <= "auto_min" (${autoMin})`,
    );
  }

  return { autoMin, confirmMin };
}
