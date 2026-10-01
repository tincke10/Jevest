/**
 * Deterministic check of a reviewer finding's evidence
 * (`reviewer.requireEvidence`). Pure: the caller hands in the head files it
 * read from the working tree (redacted, like everything the reviewer saw).
 *
 * Measured motivation: on a private golden set the per-hunk reviewer's
 * false findings asserted facts about code that does not say so ("headers
 * missing on 5xx" when middleware stamps them). With evidence required,
 * every claim must quote the code that proves it, and this module checks
 * the quote is really there:
 *
 * - in the cited file at the PR head, within ±{@link EVIDENCE_LINE_TOLERANCE}
 *   lines of the cited line (`match: "head"`);
 * - or, for code the change removed, in the hunk's before side (`before`
 *   and the diff's `-` lines) of the same file (`match: "removed"`);
 * - or, with no working tree (`headFiles: null`, e.g. the Action without a
 *   checkout) or when the hunk's own file is not readable there, anywhere in the hunk's after side — context and `+` lines —
 *   of the same file (`match: "hunk"`), then its before side.
 *
 * Quotes are compared with all whitespace removed, after dropping what a
 * model tends to add around code: diff markers, `12|` line-number
 * prefixes, a trailing ellipsis. A quote shorter than
 * {@link MIN_QUOTE_CHARS} non-space characters proves nothing and never
 * verifies. Only the first {@link MAX_EVIDENCE_ITEMS} items are checked.
 */

export const EVIDENCE_LINE_TOLERANCE = 5;
export const MAX_EVIDENCE_ITEMS = 3;
export const MIN_QUOTE_CHARS = 4;

export interface EvidenceItem {
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

export interface EvidenceHunk {
  readonly file: string;
  readonly before: string;
  readonly diff: string;
}

export interface EvidenceSources {
  readonly hunk: EvidenceHunk;
  /**
   * Repo-relative path -> the file's lines at the PR head (redacted); `null`
   * entry or missing key = not readable. `null` as a whole = no working tree.
   */
  readonly headFiles: ReadonlyMap<string, readonly string[] | null> | null;
}

export type EvidenceMatch = "head" | "removed" | "hunk" | null;

export interface EvidenceCheck {
  /** Items whose quote was found. A finding with 0 is not published. */
  readonly verified: number;
  readonly checked: number;
  readonly items: readonly { readonly item: EvidenceItem; readonly match: EvidenceMatch }[];
}

/** The paths an evidence `file` may mean: without `./` or `/`, and without a diff `a/` / `b/` prefix. */
export function evidencePathCandidates(path: string): string[] {
  const stripped = path.trim().replace(/^(?:\.\/|\/)+/, "");
  const candidates = [stripped];
  const unprefixed = stripped.replace(/^[ab]\//, "");
  if (unprefixed !== stripped) candidates.push(unprefixed);
  return candidates;
}

const LINE_NUMBER_PREFIX_RE = /^\s*\d+\s*[|:]\s?/;
const DIFF_MARKER_RE = /^[+-]/;
const ELLIPSIS_RE = /(?:\.\.\.|…)\s*$/;

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The quote's comparable forms: as written, and with model-added decoration removed. */
function quoteForms(quote: string): string[] {
  const cleaned = quote
    .replace(ELLIPSIS_RE, "")
    .split("\n")
    .map((line) => line.replace(LINE_NUMBER_PREFIX_RE, "").replace(DIFF_MARKER_RE, ""))
    .join("\n");
  const forms = new Set([squash(quote), squash(cleaned)]);
  return [...forms].filter((form) => form.length >= MIN_QUOTE_CHARS);
}

function sideLines(diff: string): { after: string[]; removed: string[] } {
  const after: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    const marker = line.charAt(0);
    if (marker === "-") removed.push(line.slice(1));
    else if (marker === "+") after.push(line.slice(1));
    else after.push(line.slice(1));
  }
  return { after, removed };
}

function containsAny(haystack: string, forms: readonly string[]): boolean {
  const squashed = squash(haystack);
  return forms.some((form) => squashed.includes(form));
}

function matchOne(item: EvidenceItem, sources: EvidenceSources): EvidenceMatch {
  const forms = quoteForms(item.quote);
  if (forms.length === 0) return null;
  const paths = evidencePathCandidates(item.file);
  const hunkFile = evidencePathCandidates(sources.hunk.file)[0];
  const isHunkFile = paths.some((p) => p === hunkFile);
  const { after, removed } = sideLines(sources.hunk.diff);

  const headFiles = sources.headFiles;
  const readable = headFiles !== null && paths.some((p) => Boolean(headFiles.get(p)));
  if (headFiles !== null && readable) {
    for (const path of paths) {
      const lines = headFiles.get(path);
      if (!lines) continue;
      const quoteLines = item.quote.split("\n").length;
      const from = Math.max(0, item.line - 1 - EVIDENCE_LINE_TOLERANCE);
      const to = Math.min(lines.length, item.line - 1 + EVIDENCE_LINE_TOLERANCE + quoteLines);
      if (from < to && containsAny(lines.slice(from, to).join("\n"), forms)) return "head";
    }
  } else if (isHunkFile && containsAny(after.join("\n"), forms)) {
    return "hunk";
  }

  if (isHunkFile && containsAny(`${sources.hunk.before}\n${removed.join("\n")}`, forms)) {
    return "removed";
  }
  return null;
}

/** Checks each evidence item against the code (see the module doc). */
export function verifyEvidence(
  evidence: readonly EvidenceItem[],
  sources: EvidenceSources,
): EvidenceCheck {
  const items = evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({
    item,
    match: matchOne(item, sources),
  }));
  return {
    verified: items.filter((i) => i.match !== null).length,
    checked: items.length,
    items,
  };
}
