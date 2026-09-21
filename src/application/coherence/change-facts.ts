/**
 * The CHANGE FACTS layer of the coherence state (H7, SPEC §4.2): everything
 * about a pull request that can be computed in code from file paths and
 * line counts alone, in any programming language, with no LLM and no diff
 * reading. Per NFR-5 every count and comparison is resolved here — Jev only
 * ever sees the resulting words (`size`, kinds, flags), never a number it
 * would have to interpret.
 *
 * Classification is heuristic by design: it recognizes well-known path
 * conventions (tests, docs, dependency manifests, CI, migrations, config,
 * assets) and calls everything else "source". A wrong kind costs one noisy
 * fact, not a wrong verdict — the summary and intent layers still carry the
 * change.
 */
import { type Size, type SizeThresholds, classifySize } from "../../domain/size.js";
import type { PrFile, PrFileStatus } from "./pr-record.js";

export const FILE_KINDS = [
  "test",
  "docs",
  "deps",
  "ci",
  "migration",
  "config",
  "assets",
  "source",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface ChangeFactsFile {
  readonly path: string;
  readonly kind: FileKind;
  readonly status: PrFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface ChangeFacts {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  /** Computed with {@link classifySize}; the only size signal Jev is meant to read. */
  readonly size: Size;
  /** Distinct language names across all files, in first-seen order. */
  readonly languages: readonly string[];
  /** Distinct top-level areas of SOURCE files only, in first-seen order. */
  readonly areas: readonly string[];
  readonly hasTests: boolean;
  readonly testsOnly: boolean;
  readonly docsOnly: boolean;
  readonly touchesDeps: boolean;
  readonly touchesCi: boolean;
  readonly touchesMigration: boolean;
  readonly touchesConfig: boolean;
  readonly addsFiles: boolean;
  readonly removesFiles: boolean;
  readonly renamesFiles: boolean;
  /** At most {@link MAX_LISTED_FILES} entries, source files first. */
  readonly files: readonly ChangeFactsFile[];
  /** True when `files` lists fewer entries than `fileCount`. */
  readonly truncated: boolean;
}

/** Same defaults as `sizes` in config/jevest.example.yml and the config adapter. */
export const DEFAULT_SIZE_THRESHOLDS: SizeThresholds = {
  smallMaxChangedLines: 50,
  mediumMaxChangedLines: 300,
};

export const MAX_LISTED_FILES = 40;

const TEST_PATTERNS = [/\/__tests__\//, /\.test\./, /\.spec\./, /\/tests?\//, /\/e2e\//];
const DOCS_PATTERNS = [/\.mdx?$/, /\/docs\//, /\/\.changeset\//];
const DEPS_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "composer.json",
  "composer.lock",
  "cargo.toml",
  "cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
]);
const DEPS_BASENAME_PATTERNS = [/^requirements[^/]*\.txt$/, /^gemfile(\..*)?$/];
const CI_PATTERNS = [/\/\.github\//, /\/\.circleci\//];
const CI_BASENAME_PATTERNS = [/^\.gitlab-ci\.yml$/, /^dockerfile(\..*)?$/, /^docker-compose.*$/];
const MIGRATION_PATTERNS = [/\/migrations?\//, /\.sql$/];
const CONFIG_EXTENSIONS = new Set(["yml", "yaml", "json", "toml", "ini"]);
const CONFIG_BASENAME_PATTERNS = [
  /^\.env\.example$/,
  /^\.editorconfig$/,
  /^\.[a-z0-9_-]*rc(\.[a-z0-9]+)?$/,
];
const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "pdf",
  "zip",
  "gz",
  "tar",
  "bin",
  "wasm",
  "mp3",
  "mp4",
  "mov",
  "wav",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  php: "php",
  vue: "vue",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  cs: "csharp",
  swift: "swift",
  sql: "sql",
  sh: "shell",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  yml: "config",
  yaml: "config",
  json: "config",
  toml: "config",
};

const GROUPED_TOP_LEVEL_FOLDERS = new Set(["packages", "apps", "src", "lib"]);

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string | undefined {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Precedence, first match wins: test, docs, deps, ci, migration, config,
 * assets, source. So `src/x.test.ts` is a test (not source), `package.json`
 * is deps (not config) and `.github/workflows/ci.yml` is ci (not config).
 */
export function classifyFileKind(path: string): FileKind {
  const lowered = `/${path.toLowerCase()}`;
  const base = basenameOf(lowered);
  const ext = extensionOf(lowered);

  if (matchesAny(lowered, TEST_PATTERNS)) return "test";
  if (matchesAny(lowered, DOCS_PATTERNS)) return "docs";
  if (DEPS_BASENAMES.has(base) || matchesAny(base, DEPS_BASENAME_PATTERNS)) return "deps";
  if (matchesAny(lowered, CI_PATTERNS) || matchesAny(base, CI_BASENAME_PATTERNS)) return "ci";
  if (matchesAny(lowered, MIGRATION_PATTERNS)) return "migration";
  if (
    (ext !== undefined && CONFIG_EXTENSIONS.has(ext)) ||
    matchesAny(base, CONFIG_BASENAME_PATTERNS)
  ) {
    return "config";
  }
  if (ext !== undefined && ASSET_EXTENSIONS.has(ext)) return "assets";
  return "source";
}

/** Language name for a path's extension; the bare extension when unknown; undefined when there is none. */
export function languageOf(path: string): string | undefined {
  const ext = extensionOf(path);
  if (ext === undefined) return undefined;
  return LANGUAGE_BY_EXTENSION[ext] ?? ext;
}

/**
 * Top-level area of a path: `packages/<name>`, `apps/<name>`, `src/<name>`
 * or `lib/<name>` when the file sits below such a grouping folder, the first
 * segment otherwise, and "<root>" for files at the repository root.
 */
export function areaOf(path: string): string {
  const segments = path.split("/");
  if (segments.length < 2) return "<root>";
  const first = segments[0] as string;
  if (GROUPED_TOP_LEVEL_FOLDERS.has(first) && segments.length > 2) {
    return `${first}/${segments[1] as string}`;
  }
  return first;
}

function distinct(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}

export function describeChange(
  files: readonly PrFile[],
  thresholds: SizeThresholds = DEFAULT_SIZE_THRESHOLDS,
): ChangeFacts {
  const classified: ChangeFactsFile[] = files.map((f) => ({
    path: f.path,
    kind: classifyFileKind(f.path),
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));

  const additions = classified.reduce((sum, f) => sum + f.additions, 0);
  const deletions = classified.reduce((sum, f) => sum + f.deletions, 0);
  const has = (kind: FileKind) => classified.some((f) => f.kind === kind);
  const only = (kind: FileKind) =>
    classified.length > 0 && classified.every((f) => f.kind === kind);
  const hasStatus = (status: PrFileStatus) => classified.some((f) => f.status === status);

  const sourceFirst = [
    ...classified.filter((f) => f.kind === "source"),
    ...classified.filter((f) => f.kind !== "source"),
  ];

  return {
    fileCount: classified.length,
    additions,
    deletions,
    size: classifySize(additions, deletions, thresholds),
    languages: distinct(classified.map((f) => languageOf(f.path))),
    areas: distinct(classified.filter((f) => f.kind === "source").map((f) => areaOf(f.path))),
    hasTests: has("test"),
    testsOnly: only("test"),
    docsOnly: only("docs"),
    touchesDeps: has("deps"),
    touchesCi: has("ci"),
    touchesMigration: has("migration"),
    touchesConfig: has("config"),
    addsFiles: hasStatus("added"),
    removesFiles: hasStatus("removed"),
    renamesFiles: hasStatus("renamed"),
    files: sourceFirst.slice(0, MAX_LISTED_FILES),
    truncated: classified.length > MAX_LISTED_FILES,
  };
}
