/**
 * Type, parser, and serializer for one line of `datasets/profile-labels.jsonl`
 * (SPEC §5 Fase 0b): the AST-derived ground truth for the surface-profile
 * question set (H0'), written by `scripts/profile/label.ts` and read back
 * by the profile report as ground truth.
 */
import { PROFILE_CHANGE_KINDS } from "../spike/question-sets/profile.js";

export type ProfileChangeKind = (typeof PROFILE_CHANGE_KINDS)[number];

export interface ProfileLabels {
  readonly changeKind: ProfileChangeKind;
  readonly touchesPublicApi: boolean;
  readonly touchesErrorHandling: boolean;
  readonly touchesAsync: boolean;
  readonly touchesIo: boolean;
}

export interface ProfileLabelRecord {
  readonly hunkId: string;
  readonly datasetVersion: number;
  readonly labels: ProfileLabels;
  readonly source: string;
  readonly needsManualReview: boolean;
}

export class ProfileLabelRecordParseError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`profile-labels.jsonl line ${lineNumber}: ${reason}`);
    this.name = "ProfileLabelRecordParseError";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined (missing)";
  if (value === null) return "null";
  return typeof value;
}

function expectObject(value: unknown, field: string, lineNumber: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `field "${field}" must be an object, got ${describe(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== "string") {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `field "${field}" must be a string, got ${describe(value)}`,
    );
  }
  return value;
}

function expectNumber(value: unknown, field: string, lineNumber: number): number {
  if (typeof value !== "number") {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `field "${field}" must be a number, got ${describe(value)}`,
    );
  }
  return value;
}

function expectBoolean(value: unknown, field: string, lineNumber: number): boolean {
  if (typeof value !== "boolean") {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `field "${field}" must be a boolean, got ${describe(value)}`,
    );
  }
  return value;
}

function expectChangeKind(value: unknown, field: string, lineNumber: number): ProfileChangeKind {
  const text = expectString(value, field, lineNumber);
  if (!(PROFILE_CHANGE_KINDS as readonly string[]).includes(text)) {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `field "${field}" must be one of ${PROFILE_CHANGE_KINDS.join(", ")}, got "${text}"`,
    );
  }
  return text as ProfileChangeKind;
}

export function parseProfileLabelRecordLine(line: string, lineNumber: number): ProfileLabelRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new ProfileLabelRecordParseError(
      lineNumber,
      `invalid JSON (${(error as Error).message})`,
    );
  }

  const obj = expectObject(raw, "<record>", lineNumber);
  const labels = expectObject(obj.labels, "labels", lineNumber);

  return {
    hunkId: expectString(obj.hunk_id, "hunk_id", lineNumber),
    datasetVersion: expectNumber(obj.dataset_version, "dataset_version", lineNumber),
    labels: {
      changeKind: expectChangeKind(labels.change_kind, "labels.change_kind", lineNumber),
      touchesPublicApi: expectBoolean(
        labels.touches_public_api,
        "labels.touches_public_api",
        lineNumber,
      ),
      touchesErrorHandling: expectBoolean(
        labels.touches_error_handling,
        "labels.touches_error_handling",
        lineNumber,
      ),
      touchesAsync: expectBoolean(labels.touches_async, "labels.touches_async", lineNumber),
      touchesIo: expectBoolean(labels.touches_io, "labels.touches_io", lineNumber),
    },
    source: expectString(obj.source, "source", lineNumber),
    needsManualReview: expectBoolean(obj.needs_manual_review, "needs_manual_review", lineNumber),
  };
}

export function parseProfileLabelRecordsJsonl(content: string): ProfileLabelRecord[] {
  const records: ProfileLabelRecord[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    records.push(parseProfileLabelRecordLine(trimmed, index + 1));
  }
  return records;
}

/** Wire format uses snake_case; this is the single source of truth for that mapping. */
export function serializeProfileLabelRecord(record: ProfileLabelRecord): string {
  return JSON.stringify({
    hunk_id: record.hunkId,
    dataset_version: record.datasetVersion,
    labels: {
      change_kind: record.labels.changeKind,
      touches_public_api: record.labels.touchesPublicApi,
      touches_error_handling: record.labels.touchesErrorHandling,
      touches_async: record.labels.touchesAsync,
      touches_io: record.labels.touchesIo,
    },
    source: record.source,
    needs_manual_review: record.needsManualReview,
  });
}
