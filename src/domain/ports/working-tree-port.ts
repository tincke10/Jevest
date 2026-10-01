/**
 * Port onto the repository's working tree at the PR head (SPEC §7 style:
 * zero SDK imports). Feeds the reviewer's code context — the full file
 * (`reviewer.fullFile`), the references to what a hunk changes
 * (`reviewer.impactContext`) — and the evidence check
 * (`reviewer.requireEvidence`). Adapters: ripgrep over a checkout
 * (../../adapters/working-tree/ripgrep-working-tree.ts) and an in-memory
 * fake for tests. Absent from the pipeline when there is no checkout of
 * the head (e.g. the Action without `actions/checkout`).
 */
import type { SymbolMatch } from "../impact-context.js";

export interface SymbolSearchOptions {
  /** Raw matches kept per symbol before ranking; the ranking caps again. */
  readonly maxMatchesPerSymbol?: number;
}

export interface WorkingTreePort {
  /**
   * The file's text at the PR head; `null` when it does not exist, is not
   * a regular readable text file, or the path escapes the tree.
   */
  readFile(path: string): Promise<string | null>;
  /**
   * Whole-word, fixed-string, case-sensitive occurrences of each symbol in
   * the tree's source files (vendored, built and lock files excluded),
   * ordered by path then line. A line matching two symbols is two matches.
   */
  searchSymbols(symbols: readonly string[], options?: SymbolSearchOptions): Promise<SymbolMatch[]>;
}
