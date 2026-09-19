/**
 * Type and loud-failing parser for one line of `datasets/findings.jsonl`
 * (SPEC §5 Fase 1a): an LLM reviewer's finding on a hunk, labeled *real*
 * or *noise* by line-overlap with the hunk's fix. This is Jevest's own
 * independent parser for the shared wire schema — it does not import the
 * "reviewer" agent's `src/domain/finding.ts`, to keep the two concurrent
 * workstreams decoupled.
 */

export type FindingSeverity = "nit" | "minor" | "major" | "critical";
const FINDING_SEVERITIES: readonly FindingSeverity[] = ["nit", "minor", "major", "critical"];

/** Widened to include claude-cli (SPEC §13): a third ReviewerPort adapter that shells out to `claude -p`. */
export type FindingReviewerProvider = "anthropic" | "openai" | "claude-cli";
const FINDING_REVIEWER_PROVIDERS: readonly FindingReviewerProvider[] = [
  "anthropic",
  "openai",
  "claude-cli",
];

export interface FindingReviewer {
  readonly provider: FindingReviewerProvider;
  readonly model: string;
}

export interface FindingLabel {
  readonly real: boolean;
  readonly source: string;
  readonly overlapLines: number;
  readonly fixChangedLines: number;
}

export interface FindingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface FindingRecord {
  readonly id: string;
  readonly hunkId: string;
  readonly datasetVersion: number;
  readonly reviewer: FindingReviewer;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
  readonly suggestedSeverity: FindingSeverity;
  readonly label: FindingLabel;
  readonly needsManualReview: boolean;
  readonly usage: FindingUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export class FindingRecordParseError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`findings.jsonl line ${lineNumber}: ${reason}`);
    this.name = "FindingRecordParseError";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined (missing)";
  if (value === null) return "null";
  return typeof value;
}

function expectObject(value: unknown, field: string, lineNumber: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be an object, got ${describe(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== "string") {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be a string, got ${describe(value)}`,
    );
  }
  return value;
}

function expectNumber(value: unknown, field: string, lineNumber: number): number {
  if (typeof value !== "number") {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be a number, got ${describe(value)}`,
    );
  }
  return value;
}

function expectBoolean(value: unknown, field: string, lineNumber: number): boolean {
  if (typeof value !== "boolean") {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be a boolean, got ${describe(value)}`,
    );
  }
  return value;
}

function expectSeverity(value: unknown, field: string, lineNumber: number): FindingSeverity {
  const text = expectString(value, field, lineNumber);
  if (!FINDING_SEVERITIES.includes(text as FindingSeverity)) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be one of ${FINDING_SEVERITIES.join(", ")}, got "${text}"`,
    );
  }
  return text as FindingSeverity;
}

function expectReviewerProvider(
  value: unknown,
  field: string,
  lineNumber: number,
): FindingReviewerProvider {
  const text = expectString(value, field, lineNumber);
  if (!FINDING_REVIEWER_PROVIDERS.includes(text as FindingReviewerProvider)) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be one of ${FINDING_REVIEWER_PROVIDERS.join(", ")}, got "${text}"`,
    );
  }
  return text as FindingReviewerProvider;
}

export function parseFindingRecordLine(line: string, lineNumber: number): FindingRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new FindingRecordParseError(lineNumber, `invalid JSON (${(error as Error).message})`);
  }

  const obj = expectObject(raw, "<record>", lineNumber);
  const reviewer = expectObject(obj.reviewer, "reviewer", lineNumber);
  const label = expectObject(obj.label, "label", lineNumber);
  const usage = expectObject(obj.usage, "usage", lineNumber);

  return {
    id: expectString(obj.id, "id", lineNumber),
    hunkId: expectString(obj.hunk_id, "hunk_id", lineNumber),
    datasetVersion: expectNumber(obj.dataset_version, "dataset_version", lineNumber),
    reviewer: {
      provider: expectReviewerProvider(reviewer.provider, "reviewer.provider", lineNumber),
      model: expectString(reviewer.model, "reviewer.model", lineNumber),
    },
    file: expectString(obj.file, "file", lineNumber),
    lineStart: expectNumber(obj.line_start, "line_start", lineNumber),
    lineEnd: expectNumber(obj.line_end, "line_end", lineNumber),
    claim: expectString(obj.claim, "claim", lineNumber),
    rationale: expectString(obj.rationale, "rationale", lineNumber),
    suggestedSeverity: expectSeverity(obj.suggested_severity, "suggested_severity", lineNumber),
    label: {
      real: expectBoolean(label.real, "label.real", lineNumber),
      source: expectString(label.source, "label.source", lineNumber),
      overlapLines: expectNumber(label.overlap_lines, "label.overlap_lines", lineNumber),
      fixChangedLines: expectNumber(label.fix_changed_lines, "label.fix_changed_lines", lineNumber),
    },
    needsManualReview: expectBoolean(obj.needs_manual_review, "needs_manual_review", lineNumber),
    usage: {
      inputTokens: expectNumber(usage.input_tokens, "usage.input_tokens", lineNumber),
      outputTokens: expectNumber(usage.output_tokens, "usage.output_tokens", lineNumber),
    },
    costUsd: expectNumber(obj.cost_usd, "cost_usd", lineNumber),
    latencyMs: expectNumber(obj.latency_ms, "latency_ms", lineNumber),
  };
}

export function parseFindingRecordsJsonl(content: string): FindingRecord[] {
  const records: FindingRecord[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    records.push(parseFindingRecordLine(trimmed, index + 1));
  }
  return records;
}
