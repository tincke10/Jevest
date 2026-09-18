/**
 * Type and loud-failing parser for one line of `datasets/hunks.jsonl`
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
