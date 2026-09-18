/**
 * Classifies a diff's size in code, never in a Jev question (SPEC NFR-5: "toda
 * cuenta, comparación numérica... se resuelve en código antes de preguntar").
 */

export type Size = "small" | "medium" | "large";

/** Thresholds live in configuration (config/policies.yaml), never hardcoded (NFR-13). */
export interface SizeThresholds {
  /** Inclusive upper bound of changed lines (additions + deletions) for "small". */
  readonly smallMaxChangedLines: number;
  /** Inclusive upper bound of changed lines (additions + deletions) for "medium". */
  readonly mediumMaxChangedLines: number;
}

export function classifySize(
  additions: number,
  deletions: number,
  thresholds: SizeThresholds,
): Size {
  if (additions < 0 || deletions < 0) {
    throw new RangeError(
      `additions and deletions must be non-negative, got additions=${additions}, deletions=${deletions}`,
    );
  }

  const changedLines = additions + deletions;

  if (changedLines <= thresholds.smallMaxChangedLines) {
    return "small";
  }
  if (changedLines <= thresholds.mediumMaxChangedLines) {
    return "medium";
  }
  return "large";
}
