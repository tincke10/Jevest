/**
 * Product context (`.jevest/context.yml` in the consumer repo): the one
 * thing a pull request cannot tell Jev by itself — what the PRODUCT is,
 * which parts of the tree matter and how much, and which rules apply
 * there. It feeds the `product` section of the triage state (see
 * pipeline/stages/triage.ts) and raises the effective risk of a PR that
 * touches a critical area, in code, never by asking Jev to weigh a number
 * (NFR-5).
 *
 * Two rules the callers must honor, both enforced by shape here:
 *
 * - The file is ALWAYS read from the PR's BASE sha (see
 *   {@link loadProductContext}). A PR that could edit the context that
 *   judges it would just declare its own area harmless.
 * - A missing file is the empty context (no areas, no product), never an
 *   error — a repo may adopt Jevest long before it writes one. An INVALID
 *   file is an error naming the path, exactly like a bad `.jevest.yml`:
 *   a rule set that fails to parse must not silently become "no rules".
 *
 * Path matching uses picomatch (zero transitive dependencies), against the
 * whole repo-relative path, with dotfiles included: `.github/**` must be
 * able to match a workflow. Everything derived from a match — areas hit,
 * the highest criticality among them, the rules that apply — is computed
 * here so Jev only ever sees words.
 */
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";

export const CRITICALITY_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

export interface ProductArea {
  readonly name: string;
  /** Globs relative to the repo root, e.g. `src/checkout/**`. */
  readonly paths: readonly string[];
  readonly criticality: Criticality;
  readonly owners: readonly string[];
  /** Plain-English rules that apply to this area; shown to Jev verbatim. */
  readonly rules: readonly string[];
}

export interface ProductContext {
  readonly product: { readonly name: string; readonly description: string } | null;
  readonly areas: readonly ProductArea[];
  readonly defaults: { readonly criticality: Criticality } | null;
}

export const EMPTY_PRODUCT_CONTEXT: ProductContext = { product: null, areas: [], defaults: null };

export interface AreaMatch {
  /** Areas touched, in first-match order over the given files, without duplicates. */
  readonly areas: readonly ProductArea[];
  /** Highest criticality among the touched areas; `null` when no area was touched. */
  readonly maxCriticality: Criticality | null;
  /** Rules of every touched area, in area order, without duplicates. */
  readonly rules: readonly string[];
  /** Files that fall in no area at all. */
  readonly unmatchedFiles: readonly string[];
}

export class ProductContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductContextError";
  }
}

const KNOWN_TOP_LEVEL_KEYS = new Set(["product", "areas", "defaults"]);

const criticalitySchema = z.enum(CRITICALITY_LEVELS);

const productContextSchema = z.object({
  product: z.object({ name: z.string().min(1), description: z.string().default("") }).optional(),
  areas: z
    .array(
      z.object({
        name: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        criticality: criticalitySchema.optional(),
        owners: z.array(z.string()).default([]),
        rules: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  defaults: z.object({ criticality: criticalitySchema }).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses the YAML text of a context file. `null` (file absent) and an
 * empty file both mean {@link EMPTY_PRODUCT_CONTEXT}. `label` names the
 * source in every error, e.g. `"<owner>/<repo>@<baseSha>:.jevest/context.yml"`.
 */
export function parseProductContext(raw: string | null, label: string): ProductContext {
  if (raw === null) {
    return EMPTY_PRODUCT_CONTEXT;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ProductContextError(
      `${label}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return EMPTY_PRODUCT_CONTEXT;
  }
  if (!isPlainObject(parsed)) {
    throw new ProductContextError(`${label} must be a mapping with product, areas and defaults`);
  }
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new ProductContextError(`${label}: unknown key "${key}"`);
    }
  }

  const result = productContextSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProductContextError(`${label}: ${result.error.message}`);
  }

  const defaults = result.data.defaults ?? null;
  const fallbackCriticality: Criticality = defaults?.criticality ?? "none";
  return {
    product: result.data.product
      ? { name: result.data.product.name, description: result.data.product.description }
      : null,
    areas: result.data.areas.map((area) => ({
      name: area.name,
      paths: area.paths,
      criticality: area.criticality ?? fallbackCriticality,
      owners: area.owners,
      rules: area.rules,
    })),
    defaults,
  };
}

export function criticalityRank(level: Criticality): number {
  return CRITICALITY_LEVELS.indexOf(level);
}

export function maxCriticality(a: Criticality, b: Criticality): Criticality {
  return criticalityRank(a) >= criticalityRank(b) ? a : b;
}

function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Which areas the changed files fall into, and what follows from that, computed in code. */
export function matchAreas(files: readonly string[], context: ProductContext): AreaMatch {
  const matchers = context.areas.map((area) => ({
    area,
    isMatch: picomatch([...area.paths], { dot: true }),
  }));

  const touched: ProductArea[] = [];
  const seen = new Set<string>();
  const unmatchedFiles: string[] = [];
  for (const file of files) {
    const path = normalizePath(file);
    let matched = false;
    for (const { area, isMatch } of matchers) {
      if (!isMatch(path)) continue;
      matched = true;
      if (!seen.has(area.name)) {
        seen.add(area.name);
        touched.push(area);
      }
    }
    if (!matched) unmatchedFiles.push(file);
  }

  const rules = [...new Set(touched.flatMap((area) => area.rules))];
  const max = touched.reduce<Criticality | null>(
    (acc, area) => (acc === null ? area.criticality : maxCriticality(acc, area.criticality)),
    null,
  );

  return { areas: touched, maxCriticality: max, rules, unmatchedFiles };
}

export interface LoadProductContextOptions {
  /** Returns the file text at `sha`, or `null` when it does not exist there. Any other failure must throw. */
  readonly fetchFile: (path: string, sha: string) => Promise<string | null>;
  readonly path: string;
  /** The PR's BASE sha — never the head: a PR must not rewrite the rules that judge it. */
  readonly baseSha: string;
  /** Names the source in errors, e.g. `"<owner>/<repo>@<baseSha>:.jevest/context.yml"`. */
  readonly label: string;
}

/**
 * Fetches and parses the context file from the base sha. Not-found (a
 * `null` from `fetchFile`) is the empty context; a fetch failure
 * propagates so the run fails closed; an invalid file throws
 * {@link ProductContextError} naming `label`.
 */
export async function loadProductContext(
  options: LoadProductContextOptions,
): Promise<ProductContext> {
  const raw = await options.fetchFile(options.path, options.baseSha);
  return parseProductContext(raw, options.label);
}
