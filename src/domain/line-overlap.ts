/**
 * Automatic ground-truth labeler for findings (SPEC §5 Fase 1a step 2, H1).
 * A finding is *real* iff the hunk it came from is a defect AND the finding's
 * line range overlaps at least one line the fix actually changed; otherwise
 * it's *noise*. "Changed" means: a removed/modified line (a `-` line, at its
 * absolute BEFORE-side line number), or — for a pure insertion with no
 * paired removal — the BEFORE-side line immediately preceding the insertion
 * point, since that's the closest "before" line the fix is anchored to.
 * Zero SDK imports.
 */
import type { FindingLabel } from "./finding.js";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseOldStart(hunkHeader: string): number {
  const match = HUNK_HEADER_RE.exec(hunkHeader.trim());
  if (!match) {
    throw new Error(`malformed hunk header, expected "@@ -a,b +c,d @@", got "${hunkHeader}"`);
  }
  return Number(match[1]);
}

/**
 * Computes the set of absolute BEFORE-side line numbers a unified diff
 * changed. `hunkHeader` seeds the counter for a diff body that doesn't start
 * with its own `@@` line; a diff with one or more `@@` headers of its own
 * resets the counter at each one (multi-segment diffs).
 */
export function computeFixChangedLines(diff: string, hunkHeader: string): Set<number> {
  const changed = new Set<number>();
  let beforeLine = parseOldStart(hunkHeader);
  let lastWasRemoval = false;
  let pureInsertionMarked = false;

  for (const rawLine of diff.split("\n")) {
    if (rawLine === "") continue;

    const headerMatch = HUNK_HEADER_RE.exec(rawLine);
    if (headerMatch) {
      beforeLine = Number(headerMatch[1]);
      lastWasRemoval = false;
      pureInsertionMarked = false;
      continue;
    }

    const prefix = rawLine[0];
    if (prefix === "\\") {
      // "\ No newline at end of file" — not a content line.
      continue;
    }
    if (rawLine.startsWith("---") || rawLine.startsWith("+++")) {
      // Unified diff file-header lines, not hunk content.
      continue;
    }

    if (prefix === "-") {
      changed.add(beforeLine);
      beforeLine += 1;
      lastWasRemoval = true;
      pureInsertionMarked = false;
      continue;
    }

    if (prefix === "+") {
      if (!lastWasRemoval && !pureInsertionMarked) {
        changed.add(beforeLine - 1);
        pureInsertionMarked = true;
      }
      continue;
    }

    // Context line (leading space, or any other unrecognized prefix — treat as context).
    beforeLine += 1;
    lastWasRemoval = false;
    pureInsertionMarked = false;
  }

  return changed;
}

export interface LabelFindingRange {
  readonly lineStart: number;
  readonly lineEnd: number;
}

/**
 * Labels a finding against the fix's changed-line set (SPEC §5 Fase 1a step 2, H1).
 * `real` requires both that the hunk is a genuine defect AND that the
 * finding's [lineStart, lineEnd] range overlaps at least one changed line.
 */
export function labelFinding(
  finding: LabelFindingRange,
  fixChangedLines: ReadonlySet<number>,
  hunkIsDefect: boolean,
): FindingLabel {
  let overlapLines = 0;
  for (let line = finding.lineStart; line <= finding.lineEnd; line++) {
    if (fixChangedLines.has(line)) {
      overlapLines += 1;
    }
  }

  return {
    real: hunkIsDefect && overlapLines >= 1,
    source: "line-overlap",
    overlapLines,
    fixChangedLines: fixChangedLines.size,
  };
}
