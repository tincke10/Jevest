/**
 * Reversal of a unified diff and of a whole {@link HunkRecord}, the core of
 * the H1b reversed dataset (`pnpm dataset:reverse`, datasets/FINDINGS.md §11).
 *
 * Why: `datasets/hunks.jsonl` hands the reviewer the bugfix commit's own diff,
 * so it is reviewing a change that ALREADY fixes the defect. Under the
 * fix-aware oracle label a finding only scores `real` when it happens to name
 * the defect being removed — 7 times in 299. Reversing the diff for the defect
 * hunks presents the buggy state as the change the "PR" introduces, so a real
 * finding is one that flags the bug the real fix later removed.
 *
 * Only `diff` is reversed. `before`, `after`, `label`, `evidence`,
 * `hunk_header`, `file`, `language`, `repo`, `commit` and `parent` stay in
 * ORIGINAL orientation, because the oracle labeler must keep seeing
 * `before` = buggy and `after` = fixed; it is the reviewer's view that moves,
 * not the ground truth's.
 *
 * Zero SDK imports: pure data transformation.
 */
import { type HunkRecord, parseHunkRecordLine } from "./hunk-record.js";

/** `@@ -<old> +<new> @@<suffix>`; `<old>`/`<new>` are `start` or `start,count`. */
const HUNK_HEADER = /^@@ -(\S+) \+(\S+) @@(.*)$/;

export class DiffReversalError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DiffReversalError";
  }
}

function reverseHeaderLine(line: string): string {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    throw new DiffReversalError(
      `malformed @@ hunk header, cannot swap its ranges: ${JSON.stringify(line)}`,
    );
  }
  const [, oldRange, newRange, suffix] = match;
  return `@@ -${newRange} +${oldRange} @@${suffix}`;
}

/**
 * Turns a unified diff around: every `-` line becomes `+` and vice versa, and
 * each `@@` header's old and new ranges swap. Context lines and blank lines
 * pass through untouched, and a `---` / `+++` file-header pair swaps as a pair
 * rather than as two body lines.
 *
 * Within each contiguous change block the swapped lines are REGROUPED so all
 * removals precede all additions. Swapping markers in place would turn
 * `-a -b +c` into `+a +b -c`, which no `git diff` ever emits; the reviewer is
 * meant to see something indistinguishable from a real pull request, so the
 * output is the canonical `-c +a +b`. A `\ No newline at end of file` marker
 * travels with the line it belongs to, since after the swap that line is on
 * the other side of the block.
 *
 * The transform is its own inverse on any canonically-ordered diff:
 * `reverseUnifiedDiff(reverseUnifiedDiff(d)) === d`.
 */
export function reverseUnifiedDiff(diff: string): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  // Each entry is one swapped line plus any `\ No newline` marker under it.
  let removals: string[][] = [];
  let additions: string[][] = [];
  let lastEntry: string[] | null = null;

  function flushBlock(): void {
    for (const entry of [...removals, ...additions]) {
      out.push(...entry);
    }
    removals = [];
    additions = [];
    lastEntry = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // File headers first: "---" and "+++" start with "-"/"+" and would
    // otherwise be mangled into body lines.
    const next = lines[i + 1];
    if (line.startsWith("--- ") && next !== undefined && next.startsWith("+++ ")) {
      flushBlock();
      out.push(`--- ${next.slice(4)}`, `+++ ${line.slice(4)}`);
      i += 1;
      continue;
    }

    // The marker qualifies the line above it, which the swap may have moved
    // to the other side of the block; keep the two together.
    if (line.startsWith("\\") && lastEntry !== null) {
      lastEntry.push(line);
      continue;
    }

    if (line.startsWith("-")) {
      lastEntry = [`+${line.slice(1)}`];
      additions.push(lastEntry);
      continue;
    }
    if (line.startsWith("+")) {
      lastEntry = [`-${line.slice(1)}`];
      removals.push(lastEntry);
      continue;
    }

    flushBlock();
    out.push(line.startsWith("@@") ? reverseHeaderLine(line) : line);
  }

  flushBlock();
  return out.join("\n");
}

/** Suffix appended to a reversed record's id, so the two datasets never share one. */
export const REVERSED_ID_SUFFIX = "-rev";

/**
 * Derives the reversed twin of one DEFECT hunk record. Benign records are
 * copied by `scripts/dataset/reverse-hunks.ts` instead of passing through
 * here: reversing a benign change would present a refactor backwards and
 * label it as if it introduced nothing, which is not a defect signal at all.
 */
export function reverseHunkRecord(record: HunkRecord): HunkRecord {
  if (!record.label.defect) {
    throw new DiffReversalError(
      `refusing to reverse benign hunk "${record.id}": reversing a non-bugfix change reveals no defect`,
    );
  }
  return {
    ...record,
    id: `${record.id}${REVERSED_ID_SUFFIX}`,
    diff: reverseUnifiedDiff(record.diff),
    orientation: "reversed",
    reversedFrom: record.id,
  };
}

/** The three orientation-dependent fields the reviewer is shown for one hunk. */
export interface ReviewerHunkView {
  readonly before: string;
  readonly hunkHeader: string;
  readonly diff: string;
}

/**
 * What the reviewer must actually be shown for a hunk, honoring its
 * orientation. The reviewer prompt presents `before` as "the code before the
 * change" — and on a reversed record the change runs fixed -> buggy, so the
 * code before it is the FIXED code, `after`. Handing the reviewer the record's
 * `before` there would pair a buggy pre-image with a diff that introduces the
 * bug, a contradiction the reviewer would be right to be confused by.
 *
 * The header comes from the reversed diff's own `@@` line for the same
 * reason: the prompt asks for absolute BEFORE-side line numbers computed from
 * the header, and only the reversed header describes the diff shown.
 * `hunk_header` on the record stays original, for the oracle labeler.
 */
export function reviewerViewOfHunk(hunk: HunkRecord): ReviewerHunkView {
  if (hunk.orientation !== "reversed") {
    return { before: hunk.before, hunkHeader: hunk.hunkHeader, diff: hunk.diff };
  }
  const headerLine = hunk.diff.split("\n").find((line) => line.startsWith("@@"));
  return {
    before: hunk.after,
    hunkHeader: headerLine ?? hunk.hunkHeader,
    diff: hunk.diff,
  };
}

export interface ReversedDataset {
  /** The whole output file, one JSON record per line, trailing newline included. */
  readonly content: string;
  readonly reversedCount: number;
  readonly copiedCount: number;
}

/**
 * Maps a whole `hunks.jsonl` onto its H1b twin: defect records reversed,
 * benign records copied verbatim (plus an explicit `orientation: "original"`,
 * so no reader has to infer orientation from a missing field). Input order is
 * preserved and the output has exactly as many records as the input — the
 * reviewer set still mixes both kinds, at the same 50/50 split.
 *
 * It works on the parsed JSON rather than on typed records on purpose, the
 * same reason `scripts/findings/label.ts` does: re-serializing from a
 * `HunkRecord` would silently drop any field this file does not know about.
 * Every line is still run through {@link parseHunkRecordLine} first, so a
 * malformed record stops the run naming its line number.
 */
export function reverseHunkJsonl(content: string): ReversedDataset {
  const out: string[] = [];
  let reversedCount = 0;
  let copiedCount = 0;

  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const lineNumber = index + 1;

    const record = parseHunkRecordLine(trimmed, lineNumber);
    if (record.orientation === "reversed" || record.reversedFrom !== undefined) {
      throw new DiffReversalError(
        `line ${lineNumber}: record "${record.id}" is already reversed; reverse datasets/hunks.jsonl, not its output`,
      );
    }
    const json = JSON.parse(trimmed) as Record<string, unknown>;

    if (record.label.defect) {
      json.id = `${record.id}${REVERSED_ID_SUFFIX}`;
      json.diff = reverseUnifiedDiff(record.diff);
      json.orientation = "reversed";
      json.reversed_from = record.id;
      reversedCount += 1;
    } else {
      json.orientation = "original";
      copiedCount += 1;
    }

    out.push(JSON.stringify(json));
  }

  return { content: `${out.join("\n")}\n`, reversedCount, copiedCount };
}
