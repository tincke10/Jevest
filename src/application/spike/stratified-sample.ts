/**
 * A seeded, label-stratified subsample for `--limit N`: datasets are
 * ordered by label (hunks defect-first, coherence pairs coherent-first per
 * PR), so a plain `slice(0, N)` would be one class only and make any
 * verdict meaningless. Picks half positive / half negative, backfilling
 * from whichever class has spare capacity when one runs short, and returns
 * the selection in original dataset order.
 *
 * {@link stratifiedSampleBy} is the generic form (any item, any predicate);
 * {@link stratifiedSample} is the hunk-specific wrapper the H0/H0' CLIs use.
 */
import type { HunkRecord } from "./hunk-record.js";
import { hashString, mulberry32 } from "./prng.js";

export interface StratifiedSampleOptions {
  readonly limit: number;
  readonly seed: number;
}

/** Fisher-Yates-equivalent shuffle via random removal; avoids in-place index swaps. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const pool = [...items];
  const result: T[] = [];
  while (pool.length > 0) {
    const index = Math.floor(rng() * pool.length);
    const [picked] = pool.splice(index, 1);
    if (picked !== undefined) {
      result.push(picked);
    }
  }
  return result;
}

/**
 * Picks `limit` items, half positive and half negative (the odd one, if any,
 * goes to positive), deterministically for a given seed. Falls back to
 * returning every item when `limit >= items.length`.
 */
export function stratifiedSampleBy<T>(
  items: readonly T[],
  isPositive: (item: T) => boolean,
  options: StratifiedSampleOptions,
): T[] {
  const { limit, seed } = options;
  if (limit < 0) {
    throw new RangeError(`limit must be >= 0, got ${limit}`);
  }
  if (limit >= items.length) {
    return [...items];
  }

  const positives = items.filter(isPositive);
  const negatives = items.filter((item) => !isPositive(item));

  let positiveCount = Math.min(Math.ceil(limit / 2), positives.length);
  let negativeCount = Math.min(limit - positiveCount, negatives.length);

  let shortfall = limit - positiveCount - negativeCount;
  if (shortfall > 0) {
    const extra = Math.min(shortfall, positives.length - positiveCount);
    positiveCount += extra;
    shortfall -= extra;
  }
  if (shortfall > 0) {
    const extra = Math.min(shortfall, negatives.length - negativeCount);
    negativeCount += extra;
    shortfall -= extra;
  }

  const rngPositive = mulberry32((seed ^ hashString("defect")) >>> 0);
  const rngNegative = mulberry32((seed ^ hashString("benign")) >>> 0);
  const selected = new Set<T>([
    ...shuffle(positives, rngPositive).slice(0, positiveCount),
    ...shuffle(negatives, rngNegative).slice(0, negativeCount),
  ]);
  return items.filter((item) => selected.has(item));
}

/** Hunk-specific wrapper: positive = defect. Same seeds and picks as before the generic form existed. */
export function stratifiedSample(
  hunks: readonly HunkRecord[],
  options: StratifiedSampleOptions,
): HunkRecord[] {
  return stratifiedSampleBy(hunks, (h) => h.label.defect, options);
}
