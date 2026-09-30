/**
 * Variant configs for pipeline eval runs (docs/EVAL.md "Variants"): a base
 * `.jevest.yml`, then an optional overrides document (YAML/JSON), then
 * `--override key.path=value` flags, in that order. The result is YAML
 * text for `loadJevestConfigFromString`, so a variant is validated exactly
 * like a real config.
 */
import { parse, stringify } from "yaml";

export interface ConfigOverride {
  readonly path: readonly string[];
  readonly value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `a.b.c=value`, the value parsed as YAML (`0.9` is a number, `false` a boolean, `[a, b]` a list). */
export function parseOverride(text: string): ConfigOverride {
  const eq = text.indexOf("=");
  const key = eq === -1 ? "" : text.slice(0, eq).trim();
  const path = key.split(".");
  if (key === "" || path.some((part) => part === "")) {
    throw new Error(
      `--override must be key=value with a dotted key (e.g. reviewer.model=x), got "${text}"`,
    );
  }
  const raw = text.slice(eq + 1);
  let value: unknown;
  try {
    value = parse(raw);
  } catch {
    value = raw;
  }
  return { path, value: value ?? raw };
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (const part of path.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
}

export function applyConfigOverrides(
  baseYaml: string | null,
  overridesDocument: unknown,
  overrides: readonly ConfigOverride[],
): string {
  const parsedBase = baseYaml === null ? null : parse(baseYaml);
  let config: unknown = parsedBase ?? {};
  if (overridesDocument !== undefined && overridesDocument !== null) {
    if (!isPlainObject(overridesDocument)) {
      throw new Error("the overrides document must be a mapping of config keys to values");
    }
    config = deepMerge(config, overridesDocument);
  }
  if (!isPlainObject(config)) {
    throw new Error("the base config must be a mapping of config keys to values");
  }
  const result = structuredClone(config);
  for (const override of overrides) setPath(result, override.path, override.value);
  return stringify(result);
}
