/**
 * Impact context for the reviewer (`reviewer.impactContext`,
 * ../application/pipeline/stages/code-context.ts): the other code that
 * references what a hunk changes. Pure — the search and the file reads
 * happen behind WorkingTreePort; this ranks what came back and cuts it into
 * snippets.
 *
 * Measured motivation: on a private golden set, the defects a per-hunk
 * reviewer could not see lived across files — a caller deriving a flag
 * from a different map, an unchanged e2e test that breaks, an unchanged
 * command drifting from changed logic. Those are exactly the references
 * this collects.
 *
 * Ranking: test files first (isTestPath: tests/, e2e/, *.spec.*, ...), then
 * callers in other files, then references in the same file outside the
 * hunk; inside each, by symbol rank (definitions before calls, see
 * ./changed-symbols.ts), then path and line. The hunk's own lines never
 * count. Caps: {@link IMPACT_MAX_MATCHES_PER_SYMBOL} matches per symbol,
 * {@link IMPACT_MAX_SNIPPETS} snippets and {@link IMPACT_MAX_CHARS}
 * characters per hunk; a snippet is ±{@link IMPACT_SNIPPET_RADIUS} lines,
 * and matches whose snippets overlap in one file merge into one.
 */
import type { LineRange } from "./file-context.js";
import { isTestPath } from "./redact.js";

export const IMPACT_MAX_MATCHES_PER_SYMBOL = 20;
export const IMPACT_MAX_SNIPPETS = 25;
export const IMPACT_SNIPPET_RADIUS = 3;
export const IMPACT_MAX_CHARS = 12_000;

export type ImpactReason = "test" | "caller" | "same-file";

const REASON_ORDER: Record<ImpactReason, number> = { test: 0, caller: 1, "same-file": 2 };

export interface SymbolMatch {
  readonly symbol: string;
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line in the file at the PR head. */
  readonly line: number;
}

export interface RankedMatch extends SymbolMatch {
  readonly reason: ImpactReason;
}

export interface ImpactSnippet {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
  /** The changed symbols this snippet references, in rank order. */
  readonly symbols: readonly string[];
  readonly reason: ImpactReason;
}

export interface ImpactContext {
  /** The symbols that were searched, most specific first. */
  readonly symbols: readonly string[];
  readonly snippets: readonly ImpactSnippet[];
  /** Characters of the snippets' text. */
  readonly chars: number;
  /** A cap (snippets or chars) left ranked matches out. */
  readonly truncated: boolean;
}

export interface ImpactHunk {
  readonly file: string;
  /** The hunk's after-side lines: references there are the change itself. */
  readonly range: LineRange;
}

/** Ranked, capped references to `symbols` outside the hunk (see the module doc). */
export function rankImpactMatches(
  matches: readonly SymbolMatch[],
  hunk: ImpactHunk,
  symbols: readonly string[],
  maxPerSymbol: number = IMPACT_MAX_MATCHES_PER_SYMBOL,
): RankedMatch[] {
  const rank = new Map(symbols.map((s, i) => [s, i]));
  const candidates: RankedMatch[] = [];
  for (const match of matches) {
    if (!rank.has(match.symbol)) continue;
    const sameFile = match.file === hunk.file;
    if (sameFile && match.line >= hunk.range.start && match.line <= hunk.range.end) continue;
    const reason: ImpactReason = isTestPath(match.file)
      ? "test"
      : sameFile
        ? "same-file"
        : "caller";
    candidates.push({ ...match, reason });
  }
  candidates.sort(
    (a, b) =>
      REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
      (rank.get(a.symbol) ?? 0) - (rank.get(b.symbol) ?? 0) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line,
  );
  const perSymbol = new Map<string, number>();
  const kept: RankedMatch[] = [];
  for (const match of candidates) {
    const count = perSymbol.get(match.symbol) ?? 0;
    if (count >= maxPerSymbol) continue;
    perSymbol.set(match.symbol, count + 1);
    kept.push(match);
  }
  return kept;
}

export interface ImpactSnippetOptions {
  readonly maxSnippets?: number;
  readonly maxChars?: number;
  readonly radius?: number;
}

interface Draft {
  readonly file: string;
  start: number;
  end: number;
  readonly symbols: string[];
  readonly reason: ImpactReason;
}

/**
 * Snippets for `ranked`, in rank order, from `files` (repo-relative path ->
 * the file's lines, already redacted). Matches in unreadable files are
 * skipped.
 */
export function buildImpactSnippets(
  ranked: readonly RankedMatch[],
  files: ReadonlyMap<string, readonly string[]>,
  options: ImpactSnippetOptions = {},
): { snippets: ImpactSnippet[]; chars: number; truncated: boolean } {
  const maxSnippets = options.maxSnippets ?? IMPACT_MAX_SNIPPETS;
  const maxChars = options.maxChars ?? IMPACT_MAX_CHARS;
  const radius = options.radius ?? IMPACT_SNIPPET_RADIUS;

  const drafts: Draft[] = [];
  let truncated = false;
  for (const match of ranked) {
    const lines = files.get(match.file);
    if (lines === undefined || lines.length === 0) continue;
    const start = Math.max(1, match.line - radius);
    const end = Math.min(lines.length, match.line + radius);
    if (start > end) continue;
    const overlapping = drafts.find(
      (d) => d.file === match.file && start <= d.end + 1 && end >= d.start - 1,
    );
    if (overlapping) {
      overlapping.start = Math.min(overlapping.start, start);
      overlapping.end = Math.max(overlapping.end, end);
      if (!overlapping.symbols.includes(match.symbol)) overlapping.symbols.push(match.symbol);
      continue;
    }
    if (drafts.length >= maxSnippets) {
      truncated = true;
      continue;
    }
    drafts.push({ file: match.file, start, end, symbols: [match.symbol], reason: match.reason });
  }

  const snippets: ImpactSnippet[] = [];
  let chars = 0;
  for (const draft of drafts) {
    const lines = (files.get(draft.file) ?? []).slice(draft.start - 1, draft.end);
    const size = lines.join("\n").length;
    if (chars + size > maxChars) {
      truncated = true;
      break;
    }
    chars += size;
    snippets.push({
      file: draft.file,
      startLine: draft.start,
      lines,
      symbols: draft.symbols,
      reason: draft.reason,
    });
  }
  return { snippets, chars, truncated };
}
