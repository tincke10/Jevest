/**
 * A seeded, label-stratified subsample of hunks for `--limit N` (dataset is
 * ordered defect-first, so a plain `slice(0, N)` would trivially be all
 * defects and make any H0 verdict meaningless). Picks half defect / half
 * benign, backfilling from whichever class has spare capacity when one
 * class runs short, and returns the selection in original dataset order.
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
 * Picks `limit` hunks, half defect and half benign (the odd one, if any,
 * goes to defect), deterministically for a given seed. Falls back to
 * returning every hunk when `limit >= hunks.length`.
 */
export function stratifiedSample(
  hunks: readonly HunkRecord[],
  options: StratifiedSampleOptions,
): HunkRecord[] {
  const { limit, seed } = options;
  if (limit < 0) {
    throw new RangeError(`limit must be >= 0, got ${limit}`);
  }
  if (limit >= hunks.length) {
    return [...hunks];
  }

  const defects = hunks.filter((h) => h.label.defect);
  const benign = hunks.filter((h) => !h.label.defect);

  let defectCount = Math.min(Math.ceil(limit / 2), defects.length);
  let benignCount = Math.min(limit - defectCount, benign.length);

  let shortfall = limit - defectCount - benignCount;
  if (shortfall > 0) {
    const extraDefect = Math.min(shortfall, defects.length - defectCount);
    defectCount += extraDefect;
    shortfall -= extraDefect;
  }
  if (shortfall > 0) {
    const extraBenign = Math.min(shortfall, benign.length - benignCount);
    benignCount += extraBenign;
    shortfall -= extraBenign;
  }

  const rngDefect = mulberry32((seed ^ hashString("defect")) >>> 0);
  const rngBenign = mulberry32((seed ^ hashString("benign")) >>> 0);
  const pickedDefect = shuffle(defects, rngDefect).slice(0, defectCount);
  const pickedBenign = shuffle(benign, rngBenign).slice(0, benignCount);

  const selectedIds = new Set([...pickedDefect, ...pickedBenign].map((h) => h.id));
  return hunks.filter((h) => selectedIds.has(h.id));
}
