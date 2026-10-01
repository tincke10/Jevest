/**
 * In-memory WorkingTreePort for tests: a map of repo-relative path -> file
 * text, searched with the same whole-word, fixed-string, case-sensitive
 * semantics as the ripgrep adapter (`rg -w -F`).
 */
import type { SymbolMatch } from "../../domain/impact-context.js";
import type { SymbolSearchOptions, WorkingTreePort } from "../../domain/ports/working-tree-port.js";

const DEFAULT_MAX_MATCHES_PER_SYMBOL = 200;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `./a` -> `a`; `null` for a path that escapes the tree. */
export function normalizeTreePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

export function createInMemoryWorkingTree(
  files: Readonly<Record<string, string>>,
): WorkingTreePort {
  const paths = Object.keys(files).sort();
  return {
    async readFile(path: string): Promise<string | null> {
      const normalized = normalizeTreePath(path);
      if (normalized === null) return null;
      return files[normalized] ?? null;
    },
    async searchSymbols(
      symbols: readonly string[],
      options: SymbolSearchOptions = {},
    ): Promise<SymbolMatch[]> {
      const max = options.maxMatchesPerSymbol ?? DEFAULT_MAX_MATCHES_PER_SYMBOL;
      const patterns = symbols.map((symbol) => ({
        symbol,
        re: new RegExp(`(?<!\\w)${escapeRegExp(symbol)}(?!\\w)`),
      }));
      const counts = new Map<string, number>();
      const matches: SymbolMatch[] = [];
      for (const file of paths) {
        const lines = (files[file] ?? "").split("\n");
        lines.forEach((text, index) => {
          for (const { symbol, re } of patterns) {
            if (!re.test(text)) continue;
            const count = counts.get(symbol) ?? 0;
            if (count >= max) continue;
            counts.set(symbol, count + 1);
            matches.push({ symbol, file, line: index + 1 });
          }
        });
      }
      return matches;
    },
  };
}
