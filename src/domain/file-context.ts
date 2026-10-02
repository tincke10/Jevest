/**
 * The full post-change content of a hunk's file, for the reviewer
 * (`reviewer.hunks.fullFile`, ../application/pipeline/stages/code-context.ts).
 * Pure: the caller reads the file from the working tree at the PR head and
 * redacts it (NFR-3) before handing it in.
 *
 * Measured motivation: on a private golden set the per-hunk reviewer
 * asserted facts about code it could not see ("the imports were removed"
 * when they moved up the same file). The whole file answers those.
 *
 * Caps: a file of at most {@link FULL_FILE_MAX_LINES} lines and
 * {@link FULL_FILE_MAX_CHARS} characters goes whole (`mode: "full"`).
 * Anything larger becomes a window of ±{@link FULL_FILE_WINDOW_RADIUS}
 * lines around the hunk plus the file's import / use / require block
 * (`mode: "window"`), shrunk further when even that is over the char cap.
 * A single line longer than {@link MAX_LINE_CHARS} (minified code) is
 * clipped.
 */

export const FULL_FILE_MAX_LINES = 2000;
export const FULL_FILE_MAX_CHARS = 80_000;
export const FULL_FILE_WINDOW_RADIUS = 150;
/** Longer lines are minified or generated code: clipped, marked. */
export const MAX_LINE_CHARS = 2000;
/** Only the top of a file is scanned for its import block. */
const IMPORT_SCAN_LINES = 300;
const IMPORT_BLOCK_MAX_LINES = 120;

export interface FileContextSegment {
  /** 1-based line number of `lines[0]` in the file at the PR head. */
  readonly startLine: number;
  readonly lines: readonly string[];
}

export interface FullFileContext {
  readonly path: string;
  readonly mode: "full" | "window";
  readonly totalLines: number;
  /** In file order, never overlapping. */
  readonly segments: readonly FileContextSegment[];
  /** Characters of the segments' text (lines joined with "\n"). */
  readonly chars: number;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** The after-side (head) line range a hunk covers, from its header; `null` when malformed. */
export function hunkNewRange(hunkHeader: string): LineRange | null {
  const match = HUNK_HEADER_RE.exec(hunkHeader);
  if (!match) return null;
  const start = Number(match[1]);
  const length = match[2] === undefined ? 1 : Number(match[2]);
  return { start, end: start + Math.max(length, 1) - 1 };
}

/** The file's lines; one trailing newline does not make an extra empty line. */
export function fileLines(content: string): string[] {
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed === "" ? [] : trimmed.split("\n");
}

const IMPORT_LINE_RE =
  /^\s*(?:import\s|import\(|export\s+(?:\*|\{[^}]*\})\s+from\s|use\s+[\\\w]|require(?:_once)?\b|include(?:_once)?\b|from\s+\S+\s+import\s|(?:const|let|var)\s+[^=]+=\s*require\(|#include\s|package\s+\w)/;

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …[clipped]` : line;
}

/** First and last import-ish line in the top of the file, as a 1-based range; `null` when none. */
function importBlock(lines: readonly string[]): LineRange | null {
  let first = -1;
  let last = -1;
  const limit = Math.min(lines.length, IMPORT_SCAN_LINES);
  for (let i = 0; i < limit; i++) {
    if (IMPORT_LINE_RE.test(lines[i] ?? "")) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return { start: first + 1, end: Math.min(last, first + IMPORT_BLOCK_MAX_LINES - 1) + 1 };
}

function segmentsFor(lines: readonly string[], ranges: readonly LineRange[]): FileContextSegment[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.max(1, r.start), end: Math.min(lines.length, r.end) }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged.map((r) => ({ startLine: r.start, lines: lines.slice(r.start - 1, r.end) }));
}

function charsOf(segments: readonly FileContextSegment[]): number {
  return segments.reduce((sum, s) => sum + s.lines.join("\n").length, 0);
}

/**
 * The reviewer's view of `content` (already redacted) around `hunk`, the
 * hunk's after-side line range. See the module doc for the caps.
 */
export function buildFullFileContext(
  path: string,
  content: string,
  hunk: LineRange,
): FullFileContext {
  const raw = fileLines(content);
  const lines = raw.map(clip);
  const totalLines = lines.length;

  const whole = segmentsFor(lines, [{ start: 1, end: totalLines }]);
  if (totalLines <= FULL_FILE_MAX_LINES && charsOf(whole) <= FULL_FILE_MAX_CHARS) {
    return { path, mode: "full", totalLines, segments: whole, chars: charsOf(whole) };
  }

  const imports = importBlock(lines);
  const windowFor = (radius: number, withImports: boolean): FileContextSegment[] =>
    segmentsFor(lines, [
      ...(withImports && imports ? [imports] : []),
      { start: hunk.start - radius, end: hunk.end + radius },
    ]);

  for (const withImports of [true, false]) {
    for (let radius = FULL_FILE_WINDOW_RADIUS; radius >= 0; radius--) {
      const segments = windowFor(radius, withImports);
      if (charsOf(segments) <= FULL_FILE_MAX_CHARS) {
        return { path, mode: "window", totalLines, segments, chars: charsOf(segments) };
      }
    }
  }

  // Even the hunk's own lines are over the cap: keep as many as fit.
  const kept: string[] = [];
  let chars = 0;
  const start = Math.max(1, Math.min(hunk.start, totalLines));
  for (const line of lines.slice(start - 1, Math.min(hunk.end, totalLines))) {
    const extra = line.length + (kept.length > 0 ? 1 : 0);
    if (chars + extra > FULL_FILE_MAX_CHARS) break;
    kept.push(line);
    chars += extra;
  }
  const segments = kept.length > 0 ? [{ startLine: start, lines: kept }] : [];
  return { path, mode: "window", totalLines, segments, chars: charsOf(segments) };
}
