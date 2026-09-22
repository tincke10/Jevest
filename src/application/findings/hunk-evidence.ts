/**
 * Type and loud-failing parser/serializer for one line of
 * `datasets/hunk-evidence.jsonl` (datasets/README.md §"hunk-evidence.jsonl"):
 * the title and body of the issue and pull request linked from a hunk's
 * commit, fetched once by `scripts/dataset/collect-evidence.ts` so the
 * fix-aware oracle labeler can read what the fix was actually for.
 *
 * It is a SEPARATE file from `hunks.jsonl` on purpose: `hunks.jsonl` is the
 * published phase-0 dataset and nothing here may mutate it. A hunk whose
 * issue or PR could not be fetched (deleted, private, 404) simply has those
 * fields absent — that is a normal outcome, not an error, and the labeler
 * then works from the commit message alone.
 *
 * Zero SDK imports: application-layer data loading, not a port.
 */

export interface HunkEvidenceRecord {
  /** Foreign key into datasets/hunks.jsonl. */
  readonly hunkId: string;
  readonly issueTitle?: string;
  readonly issueBody?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  /** ISO 8601 instant the fetch ran, so a stale evidence file is visible. */
  readonly fetchedAt: string;
}

export class HunkEvidenceParseError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`hunk-evidence.jsonl line ${lineNumber}: ${reason}`);
    this.name = "HunkEvidenceParseError";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined (missing)";
  if (value === null) return "null";
  return typeof value;
}

function expectString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== "string") {
    throw new HunkEvidenceParseError(
      lineNumber,
      `field "${field}" must be a string, got ${describe(value)}`,
    );
  }
  return value;
}

function expectOptionalString(
  value: unknown,
  field: string,
  lineNumber: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return expectString(value, field, lineNumber);
}

export function parseHunkEvidenceLine(line: string, lineNumber: number): HunkEvidenceRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new HunkEvidenceParseError(lineNumber, `invalid JSON (${(error as Error).message})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HunkEvidenceParseError(lineNumber, `record must be an object, got ${describe(raw)}`);
  }
  const obj = raw as Record<string, unknown>;

  const issueTitle = expectOptionalString(obj.issue_title, "issue_title", lineNumber);
  const issueBody = expectOptionalString(obj.issue_body, "issue_body", lineNumber);
  const prTitle = expectOptionalString(obj.pr_title, "pr_title", lineNumber);
  const prBody = expectOptionalString(obj.pr_body, "pr_body", lineNumber);

  return {
    hunkId: expectString(obj.hunk_id, "hunk_id", lineNumber),
    ...(issueTitle !== undefined ? { issueTitle } : {}),
    ...(issueBody !== undefined ? { issueBody } : {}),
    ...(prTitle !== undefined ? { prTitle } : {}),
    ...(prBody !== undefined ? { prBody } : {}),
    fetchedAt: expectString(obj.fetched_at, "fetched_at", lineNumber),
  };
}

export function parseHunkEvidenceJsonl(content: string): HunkEvidenceRecord[] {
  const records: HunkEvidenceRecord[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    records.push(parseHunkEvidenceLine(trimmed, index + 1));
  }
  return records;
}

export interface GitHubRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const GITHUB_REF = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

/**
 * Parses a `hunks.jsonl` `evidence.issue_url` / `evidence.pr_url` into the
 * pieces `gh api repos/{owner}/{repo}/issues/{number}` needs. Returns null
 * rather than throwing for anything unrecognised: a hunk whose evidence link
 * points somewhere else is a normal record, not a dataset error.
 *
 * Both issue and pull URLs map to the same `issues` endpoint — on GitHub a
 * pull request IS an issue, and that endpoint returns the title and body for
 * either one.
 */
export function parseGitHubRef(url: string | null | undefined): GitHubRef | null {
  if (typeof url !== "string") return null;
  const match = GITHUB_REF.exec(url.trim());
  if (match === null) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  return { owner, repo, number: Number(number) };
}

/**
 * Normalises and caps an issue/PR body for the dataset. The cap keeps the
 * labeler prompt bounded (issue bodies run to thousands of lines of logs), and
 * the marker is explicit so a labeler reading a cut-off body knows it is cut
 * off rather than treating silence as evidence of absence.
 */
export function truncateEvidenceBody(
  body: string | null | undefined,
  maxChars: number,
): string | undefined {
  if (typeof body !== "string") return undefined;
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n[truncated at ${maxChars} characters]`;
}

/** Serializes back to the snake_case wire shape, no trailing newline; absent stays absent. */
export function stringifyHunkEvidenceRecord(record: HunkEvidenceRecord): string {
  return JSON.stringify({
    hunk_id: record.hunkId,
    ...(record.issueTitle !== undefined ? { issue_title: record.issueTitle } : {}),
    ...(record.issueBody !== undefined ? { issue_body: record.issueBody } : {}),
    ...(record.prTitle !== undefined ? { pr_title: record.prTitle } : {}),
    ...(record.prBody !== undefined ? { pr_body: record.prBody } : {}),
    fetched_at: record.fetchedAt,
  });
}
