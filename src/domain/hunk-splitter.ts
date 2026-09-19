/**
 * Splits a `PullRequestFile.patch` (unified diff) into hunks. Output is
 * intentionally shaped close to the spike's `HunkRecord` (`file`,
 * `hunkHeader`, `before`, `after`, `diff`) so the pipeline can build
 * spike-serializer-compatible objects on top of it and reuse the spike's
 * serializers and question sets rather than duplicating them.
 */

export interface SplitHunk {
  readonly file: string;
  /** The full `@@ -a,b +c,d @@ trailing context` line. */
  readonly hunkHeader: string;
  readonly before: string;
  readonly after: string;
  /** The raw hunk text: header line plus every body line, exactly as given. */
  readonly diff: string;
  readonly oldStart: number;
  readonly newStart: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/;

/**
 * Splits one file's unified diff patch into hunks. Tolerates `undefined`
 * (binary files, or patches GitHub omits for very large diffs) and empty
 * patches by returning `[]`. Handles multiple hunks per file, added files
 * (before empty), removed files (after empty), and a trailing
 * `\ No newline at end of file` marker (kept in `diff`, excluded from
 * `before`/`after` content).
 */
export function splitFileIntoHunks(file: string, patch: string | undefined): SplitHunk[] {
  if (!patch) {
    return [];
  }

  const lines = patch.split("\n");
  const hunks: SplitHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i];
    const match = headerLine !== undefined ? HUNK_HEADER_RE.exec(headerLine) : null;
    if (!match || headerLine === undefined) {
      i++;
      continue;
    }

    const oldStart = Number(match[1]);
    const newStart = Number(match[2]);
    const bodyLines: string[] = [headerLine];
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    i++;

    while (i < lines.length) {
      const bodyLine = lines[i];
      if (bodyLine === undefined || HUNK_HEADER_RE.test(bodyLine)) break;

      bodyLines.push(bodyLine);
      if (bodyLine.startsWith("\\")) {
        // "\ No newline at end of file" — diff metadata, not content.
        i++;
        continue;
      }

      const marker = bodyLine.charAt(0);
      const content = bodyLine.slice(1);
      if (marker === " ") {
        beforeLines.push(content);
        afterLines.push(content);
      } else if (marker === "-") {
        beforeLines.push(content);
      } else if (marker === "+") {
        afterLines.push(content);
      }
      i++;
    }

    hunks.push({
      file,
      hunkHeader: headerLine,
      before: beforeLines.join("\n"),
      after: afterLines.join("\n"),
      diff: bodyLines.join("\n"),
      oldStart,
      newStart,
    });
  }

  return hunks;
}

/**
 * Maps an absolute BEFORE-side line number to its absolute AFTER-side (HEAD)
 * line number, using this hunk's own diff. Needed because
 * `ReviewFindingCandidate.lineStart`/`lineEnd` are documented as before-side
 * lines, but `InlineComment.line` (the shared VCS contract) must be a
 * head-side line. A context line (present on both sides) maps straight
 * across, tracking any shift from insertions/deletions earlier in the hunk.
 * A removed line (before-only, no after counterpart) anchors at the
 * after-side position immediately following the deletion — the gap where it
 * used to be, i.e. the position of whatever now follows it. A `beforeLine`
 * outside this hunk's before-range falls back to `hunk.newStart`.
 */
export function mapBeforeLineToAfterLine(
  hunk: Pick<SplitHunk, "diff" | "oldStart" | "newStart">,
  beforeLine: number,
): number {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const bodyLine of hunk.diff.split("\n")) {
    if (bodyLine.startsWith("@@") || bodyLine.startsWith("\\")) continue;

    const marker = bodyLine.charAt(0);
    if (marker === "-") {
      if (oldLine === beforeLine) {
        return newLine;
      }
      oldLine++;
    } else if (marker === "+") {
      newLine++;
    } else {
      if (oldLine === beforeLine) {
        return newLine;
      }
      oldLine++;
      newLine++;
    }
  }

  return hunk.newStart;
}
