/**
 * WorkingTreePort over a checkout of the PR head: `rg` for the symbol
 * search, the filesystem for reads.
 *
 * Search: ONE `rg --json -n -w -F --sort path -e <sym> ...` per call (per
 * hunk), fixed strings and whole words, so a symbol is never a regex and
 * `-e` keeps a leading dash from reading as a flag. `.gitignore` is
 * respected (also outside a git repo, `--no-require-git`); `.git`,
 * `node_modules`, `vendor`, `dist`, `build`, `storage`, `public/build`,
 * minified files, source maps and lock files are excluded
 * ({@link RIPGREP_EXCLUDE_GLOBS}); files over 1 MB are skipped. `--sort
 * path` makes the output deterministic (and single-threaded; measured fast
 * enough per hunk). The path `.` is explicit so rg never reads stdin.
 * Exit 1 is "no match"; exit 2 with matches is a partial result (e.g. an
 * unreadable file) and kept; exit 2 without any is an error.
 *
 * Reads: the path is resolved inside the root and re-checked after
 * resolving symlinks, so neither `../` nor a symlink can read outside the
 * tree — the path comes from an LLM's evidence citation. Directories,
 * missing files, files over 2 MB and binary files (a NUL byte) are `null`.
 *
 * The spawn is injectable, like the claude-cli adapters, so unit tests
 * never launch a process; the integration test runs the real `rg`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SymbolMatch } from "../../domain/impact-context.js";
import type { SymbolSearchOptions, WorkingTreePort } from "../../domain/ports/working-tree-port.js";
import { normalizeTreePath } from "./in-memory-working-tree.js";

export const RIPGREP_EXCLUDE_GLOBS: readonly string[] = [
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "storage",
  "public/build",
  "*.min.*",
  "*.map",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
];

const DEFAULT_MAX_MATCHES_PER_SYMBOL = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Matching lines kept per file per call: a file that uses a name 500 times adds nothing past the first few. */
const MAX_COUNT_PER_FILE = 10;

export interface RipgrepProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type RipgrepSpawn = (
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<RipgrepProcessResult>;

export interface RipgrepWorkingTreeOptions {
  /** Absolute path of the checkout of the PR head. */
  readonly root: string;
  /** Injectable for tests; default spawns `rg`. */
  readonly spawn?: RipgrepSpawn;
  readonly timeoutMs?: number;
}

function defaultSpawn(
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<RipgrepProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn("rg", args as string[], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run rg (is ripgrep installed?): ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}

interface RgMatchEvent {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly line_number?: number;
    readonly submatches?: readonly { readonly match?: { readonly text?: string } }[];
  };
}

/** Match events -> one SymbolMatch per distinct asked symbol per line, capped per symbol. */
export function parseRipgrepJson(
  stdout: string,
  symbols: readonly string[],
  maxPerSymbol: number,
): SymbolMatch[] {
  const asked = new Set(symbols);
  const counts = new Map<string, number>();
  const matches: SymbolMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    let event: RgMatchEvent;
    try {
      event = JSON.parse(raw) as RgMatchEvent;
    } catch {
      continue;
    }
    if (event.type !== "match" || !event.data) continue;
    const path = event.data.path?.text;
    const line = event.data.line_number;
    if (path === undefined || typeof line !== "number") continue;
    const file = path.replace(/^\.\//, "");
    const seen = new Set<string>();
    for (const sub of event.data.submatches ?? []) {
      const text = sub.match?.text;
      if (text === undefined || !asked.has(text) || seen.has(text)) continue;
      seen.add(text);
      const count = counts.get(text) ?? 0;
      if (count >= maxPerSymbol) continue;
      counts.set(text, count + 1);
      matches.push({ symbol: text, file, line });
    }
  }
  return matches;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function createRipgrepWorkingTree(options: RipgrepWorkingTreeOptions): WorkingTreePort {
  const spawnFn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = resolve(options.root);
  let realRoot: Promise<string> | null = null;

  return {
    async readFile(path: string): Promise<string | null> {
      const normalized = normalizeTreePath(path);
      if (normalized === null) return null;
      const full = resolve(root, normalized);
      if (!isInside(root, full)) return null;
      try {
        realRoot ??= realpath(root);
        const [real, rootReal] = await Promise.all([realpath(full), realRoot]);
        if (!isInside(rootReal, real)) return null;
        const info = await stat(real);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
        const text = await readFile(real, "utf8");
        return text.includes("\u0000") ? null : text;
      } catch {
        return null;
      }
    },

    async searchSymbols(
      symbols: readonly string[],
      searchOptions: SymbolSearchOptions = {},
    ): Promise<SymbolMatch[]> {
      if (symbols.length === 0) return [];
      const args = [
        "--json",
        "-n",
        "-w",
        "-F",
        "--no-config",
        "--no-require-git",
        "--sort",
        "path",
        "--max-filesize",
        "1M",
        "--max-count",
        String(MAX_COUNT_PER_FILE),
        ...RIPGREP_EXCLUDE_GLOBS.flatMap((glob) => ["-g", `!${glob}`]),
        ...symbols.flatMap((symbol) => ["-e", symbol]),
        "--",
        ".",
      ];
      const result = await spawnFn(args, { cwd: root, timeoutMs });
      const matches = parseRipgrepJson(
        result.stdout,
        symbols,
        searchOptions.maxMatchesPerSymbol ?? DEFAULT_MAX_MATCHES_PER_SYMBOL,
      );
      if (result.exitCode === 2 && matches.length === 0) {
        throw new Error(`rg failed (exit 2): ${result.stderr.trim().slice(0, 300)}`);
      }
      return matches;
    },
  };
}
