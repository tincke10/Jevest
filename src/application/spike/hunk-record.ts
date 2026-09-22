/**
 * Type and loud-failing parser for one line of `datasets/hunks.jsonl` and of
 * its reversed twin `datasets/hunks-reversed.jsonl`
 * (see datasets/README.md §1-3 for the schema and labeling protocol).
 * Zero SDK imports: this is application-layer data loading, not a port.
 */

export interface HunkRecordLabel {
  readonly defect: boolean;
  readonly category: string;
  readonly touchesPublicApi: boolean | null;
  readonly touchesSecurity: boolean | null;
  readonly source: string;
}

export interface HunkRecordEvidence {
  readonly commitMessage: string;
  readonly issueUrl: string | null;
  readonly prUrl: string | null;
}

/**
 * Which direction the record's `diff` runs. Absent on `datasets/hunks.jsonl`,
 * where every diff is the bugfix commit's own change (before -> after).
 *
 * - `"original"`: `diff` goes before -> after, same as an absent field.
 * - `"reversed"`: `diff` goes after -> before, i.e. the change INTRODUCES the
 *   buggy state (H1b, datasets/FINDINGS.md §11). `before`, `after`, `label`
 *   and `evidence` stay in original orientation on purpose, so the fix-aware
 *   oracle labeler keeps seeing `before` = buggy and `after` = fixed.
 */
export type HunkOrientation = "original" | "reversed";

export const HUNK_ORIENTATIONS: readonly HunkOrientation[] = ["original", "reversed"];

export interface HunkRecord {
  readonly id: string;
  readonly repo: string;
  readonly license: string;
  readonly commit: string;
  readonly parent: string;
  readonly file: string;
  readonly language: string;
  readonly hunkHeader: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
  readonly label: HunkRecordLabel;
  readonly evidence: HunkRecordEvidence;
  readonly needsManualReview: boolean;
  /** Dataset schema/content version. Optional in the source file; defaults to 1 when absent. */
  readonly datasetVersion: number;
  /** Absent on `hunks.jsonl`; set by `pnpm dataset:reverse`. See {@link HunkOrientation}. */
  readonly orientation?: HunkOrientation;
  /** The id of the original record this one was derived from, on a reversed record only. */
  readonly reversedFrom?: string;
}

export class HunkRecordParseError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`hunks.jsonl line ${lineNumber}: ${reason}`);
    this.name = "HunkRecordParseError";
  }
}

function expectObject(value: unknown, field: string, lineNumber: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HunkRecordParseError(
      lineNumber,
      `field "${field}" must be an object, got ${describe(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== "string") {
    throw new HunkRecordParseError(
      lineNumber,
      `field "${field}" must be a string, got ${describe(value)}`,
    );
  }
  return value;
}

function expectNullableString(value: unknown, field: string, lineNumber: number): string | null {
  if (value === null) return null;
  return expectString(value, field, lineNumber);
}

function expectBoolean(value: unknown, field: string, lineNumber: number): boolean {
  if (typeof value !== "boolean") {
    throw new HunkRecordParseError(
      lineNumber,
      `field "${field}" must be a boolean, got ${describe(value)}`,
    );
  }
  return value;
}

function expectNullableBoolean(value: unknown, field: string, lineNumber: number): boolean | null {
  if (value === null) return null;
  return expectBoolean(value, field, lineNumber);
}

function expectOptionalNumber(
  value: unknown,
  field: string,
  lineNumber: number,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number") {
    throw new HunkRecordParseError(
      lineNumber,
      `field "${field}" must be a number, got ${describe(value)}`,
    );
  }
  return value;
}

function expectOptionalString(
  value: unknown,
  field: string,
  lineNumber: number,
): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, field, lineNumber);
}

function expectOptionalOrientation(
  value: unknown,
  field: string,
  lineNumber: number,
): HunkOrientation | undefined {
  if (value === undefined) return undefined;
  const text = expectString(value, field, lineNumber);
  if (!HUNK_ORIENTATIONS.includes(text as HunkOrientation)) {
    throw new HunkRecordParseError(
      lineNumber,
      `field "${field}" must be one of ${HUNK_ORIENTATIONS.join(", ")}, got "${text}"`,
    );
  }
  return text as HunkOrientation;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined (missing)";
  if (value === null) return "null";
  return typeof value;
}

/** Parses and validates one JSONL line. Fails loudly, citing the line number and field. */
export function parseHunkRecordLine(line: string, lineNumber: number): HunkRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new HunkRecordParseError(lineNumber, `invalid JSON (${(error as Error).message})`);
  }

  const obj = expectObject(raw, "<record>", lineNumber);
  const label = expectObject(obj.label, "label", lineNumber);
  const evidence = expectObject(obj.evidence, "evidence", lineNumber);
  // Spread-when-present rather than `: undefined`, so a record from
  // hunks.jsonl parses to exactly the object it always did (exactOptionalPropertyTypes).
  const orientation = expectOptionalOrientation(obj.orientation, "orientation", lineNumber);
  const reversedFrom = expectOptionalString(obj.reversed_from, "reversed_from", lineNumber);

  return {
    id: expectString(obj.id, "id", lineNumber),
    repo: expectString(obj.repo, "repo", lineNumber),
    license: expectString(obj.license, "license", lineNumber),
    commit: expectString(obj.commit, "commit", lineNumber),
    parent: expectString(obj.parent, "parent", lineNumber),
    file: expectString(obj.file, "file", lineNumber),
    language: expectString(obj.language, "language", lineNumber),
    hunkHeader: expectString(obj.hunk_header, "hunk_header", lineNumber),
    before: expectString(obj.before, "before", lineNumber),
    after: expectString(obj.after, "after", lineNumber),
    diff: expectString(obj.diff, "diff", lineNumber),
    label: {
      defect: expectBoolean(label.defect, "label.defect", lineNumber),
      category: expectString(label.category, "label.category", lineNumber),
      touchesPublicApi: expectNullableBoolean(
        label.touches_public_api,
        "label.touches_public_api",
        lineNumber,
      ),
      touchesSecurity: expectNullableBoolean(
        label.touches_security,
        "label.touches_security",
        lineNumber,
      ),
      source: expectString(label.source, "label.source", lineNumber),
    },
    evidence: {
      commitMessage: expectString(evidence.commit_message, "evidence.commit_message", lineNumber),
      issueUrl: expectNullableString(evidence.issue_url, "evidence.issue_url", lineNumber),
      prUrl: expectNullableString(evidence.pr_url, "evidence.pr_url", lineNumber),
    },
    needsManualReview: expectBoolean(obj.needs_manual_review, "needs_manual_review", lineNumber),
    datasetVersion: expectOptionalNumber(obj.dataset_version, "dataset_version", lineNumber, 1),
    ...(orientation === undefined ? {} : { orientation }),
    ...(reversedFrom === undefined ? {} : { reversedFrom }),
  };
}

/** Parses every non-blank line of a `hunks.jsonl`-shaped file, in order. */
export function parseHunkRecordsJsonl(content: string): HunkRecord[] {
  const records: HunkRecord[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    records.push(parseHunkRecordLine(trimmed, index + 1));
  }
  return records;
}
