/**
 * Type and loud-failing parser/serializer for one line of `datasets/findings.jsonl`
 * (SPEC §5 Fase 1a, step 1-2). Zero SDK imports: this is domain vocabulary shared
 * between the ReviewerPort adapters, the findings generation pipeline, and the
 * line-overlap labeler. Mirrors the shape and error style of
 * `src/application/spike/hunk-record.ts`.
 */

export type ReviewerProvider = "anthropic" | "openai" | "deepseek" | "claude-cli";
export type FindingSeverity = "nit" | "minor" | "major" | "critical";
/** How the reviewer call was paid for. Omitted on the wire (and undefined here) means "api". */
export type FindingBilling = "api" | "subscription";

export interface FindingReviewer {
  readonly provider: ReviewerProvider;
  readonly model: string;
}

export interface FindingLabel {
  readonly real: boolean;
  readonly source: "line-overlap";
  readonly overlapLines: number;
  readonly fixChangedLines: number;
}

export interface FindingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** One line of `datasets/findings.jsonl`, camelCase on the domain side. */
export interface FindingRecord {
  readonly id: string;
  readonly hunkId: string;
  readonly datasetVersion: 2;
  readonly reviewer: FindingReviewer;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
  readonly suggestedSeverity: FindingSeverity;
  readonly label: FindingLabel;
  readonly needsManualReview: true;
  readonly usage: FindingUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  /**
   * Present only for a non-default value ("subscription"): a claude-cli
   * reviewer call spends Claude subscription quota, not API cash, so
   * `costUsd` for it is a nominal list-price figure, not real spend.
   * Absent means "api" (the default, real spend).
   */
  readonly billing?: FindingBilling;
}

export class FindingRecordParseError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`findings.jsonl line ${lineNumber}: ${reason}`);
    this.name = "FindingRecordParseError";
  }
}

const REVIEWER_PROVIDERS = new Set<ReviewerProvider>([
  "anthropic",
  "openai",
  "deepseek",
  "claude-cli",
]);
const FINDING_SEVERITIES = new Set<FindingSeverity>(["nit", "minor", "major", "critical"]);
const FINDING_BILLINGS = new Set<FindingBilling>(["api", "subscription"]);

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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be a finite number, got ${describe(value)}`,
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

function expectTrue(value: unknown, field: string, lineNumber: number): true {
  if (value !== true) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be literally true, got ${describe(value)}`,
    );
  }
  return true;
}

function expectLiteral2(value: unknown, field: string, lineNumber: number): 2 {
  if (value !== 2) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be 2 (the only supported dataset version for findings), got ${describe(value)}`,
    );
  }
  return 2;
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  field: string,
  lineNumber: number,
): T {
  const str = expectString(value, field, lineNumber);
  if (!allowed.has(str as T)) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be one of ${[...allowed].join(", ")}, got "${str}"`,
    );
  }
  return str as T;
}

function expectOptionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  field: string,
  lineNumber: number,
): T | undefined {
  if (value === undefined) return undefined;
  return expectEnum(value, allowed, field, lineNumber);
}

function expectLiteralString<T extends string>(
  value: unknown,
  literal: T,
  field: string,
  lineNumber: number,
): T {
  const str = expectString(value, field, lineNumber);
  if (str !== literal) {
    throw new FindingRecordParseError(
      lineNumber,
      `field "${field}" must be "${literal}", got "${str}"`,
    );
  }
  return literal;
}

/** Parses and validates one JSONL line. Fails loudly, citing the line number and field. */
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
  const billing = expectOptionalEnum(obj.billing, FINDING_BILLINGS, "billing", lineNumber);

  return {
    id: expectString(obj.id, "id", lineNumber),
    hunkId: expectString(obj.hunk_id, "hunk_id", lineNumber),
    datasetVersion: expectLiteral2(obj.dataset_version, "dataset_version", lineNumber),
    reviewer: {
      provider: expectEnum(reviewer.provider, REVIEWER_PROVIDERS, "reviewer.provider", lineNumber),
      model: expectString(reviewer.model, "reviewer.model", lineNumber),
    },
    file: expectString(obj.file, "file", lineNumber),
    lineStart: expectNumber(obj.line_start, "line_start", lineNumber),
    lineEnd: expectNumber(obj.line_end, "line_end", lineNumber),
    claim: expectString(obj.claim, "claim", lineNumber),
    rationale: expectString(obj.rationale, "rationale", lineNumber),
    suggestedSeverity: expectEnum(
      obj.suggested_severity,
      FINDING_SEVERITIES,
      "suggested_severity",
      lineNumber,
    ),
    label: {
      real: expectBoolean(label.real, "label.real", lineNumber),
      source: expectLiteralString(label.source, "line-overlap", "label.source", lineNumber),
      overlapLines: expectNumber(label.overlap_lines, "label.overlap_lines", lineNumber),
      fixChangedLines: expectNumber(label.fix_changed_lines, "label.fix_changed_lines", lineNumber),
    },
    needsManualReview: expectTrue(obj.needs_manual_review, "needs_manual_review", lineNumber),
    usage: {
      inputTokens: expectNumber(usage.input_tokens, "usage.input_tokens", lineNumber),
      outputTokens: expectNumber(usage.output_tokens, "usage.output_tokens", lineNumber),
      cacheReadInputTokens: expectNumber(
        usage.cache_read_input_tokens,
        "usage.cache_read_input_tokens",
        lineNumber,
      ),
      cacheCreationInputTokens: expectNumber(
        usage.cache_creation_input_tokens,
        "usage.cache_creation_input_tokens",
        lineNumber,
      ),
    },
    costUsd: expectNumber(obj.cost_usd, "cost_usd", lineNumber),
    latencyMs: expectNumber(obj.latency_ms, "latency_ms", lineNumber),
    ...(billing !== undefined ? { billing } : {}),
  };
}

/** Parses every non-blank line of a `findings.jsonl`-shaped file, in order. */
export function parseFindingRecordsJsonl(content: string): FindingRecord[] {
  const records: FindingRecord[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    records.push(parseFindingRecordLine(trimmed, index + 1));
  }
  return records;
}

/**
 * Serializes a FindingRecord back to the exact snake_case JSONL shape, no
 * trailing newline. `billing` is only emitted when non-default
 * ("subscription"), so a record parsed without it round-trips byte-for-byte
 * without acquiring one.
 */
export function stringifyFindingRecord(record: FindingRecord): string {
  return JSON.stringify({
    id: record.id,
    hunk_id: record.hunkId,
    dataset_version: record.datasetVersion,
    reviewer: { provider: record.reviewer.provider, model: record.reviewer.model },
    file: record.file,
    line_start: record.lineStart,
    line_end: record.lineEnd,
    claim: record.claim,
    rationale: record.rationale,
    suggested_severity: record.suggestedSeverity,
    label: {
      real: record.label.real,
      source: record.label.source,
      overlap_lines: record.label.overlapLines,
      fix_changed_lines: record.label.fixChangedLines,
    },
    needs_manual_review: record.needsManualReview,
    usage: {
      input_tokens: record.usage.inputTokens,
      output_tokens: record.usage.outputTokens,
      cache_read_input_tokens: record.usage.cacheReadInputTokens,
      cache_creation_input_tokens: record.usage.cacheCreationInputTokens,
    },
    cost_usd: record.costUsd,
    latency_ms: record.latencyMs,
    ...(record.billing !== undefined ? { billing: record.billing } : {}),
  });
}
