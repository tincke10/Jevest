/**
 * Shared records for the intent–change coherence spike (H7, SPEC §4.2):
 * one merged pull request as collected from GitHub (`datasets/prs.jsonl`)
 * and one evaluation pair (`datasets/coherence-pairs.jsonl`) that pins a
 * PR's CHANGE to some PR's DESCRIPTION. A pair is "coherent" when both ids
 * are the same PR and "incoherent" when the description was taken from a
 * different PR of the same repo — the crossed-description construction
 * gives exact ground truth with zero manual labeling.
 *
 * Wire format is snake_case JSONL like every other dataset in this repo;
 * the in-memory shape is camelCase. Zero SDK imports.
 */
import { z } from "zod";

export const PR_FILE_STATUSES = ["added", "modified", "removed", "renamed"] as const;
export type PrFileStatus = (typeof PR_FILE_STATUSES)[number];

export interface PrFile {
  readonly path: string;
  readonly status: PrFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** Unified diff for this file; absent for binary files and for files GitHub did not return a patch for. */
  readonly patch?: string;
}

export interface PrRecord {
  /** `${repo}#${number}`, unique across the dataset. */
  readonly id: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** PR description with template boilerplate and HTML comments stripped, secrets redacted. */
  readonly body: string;
  readonly labels: readonly string[];
  readonly author: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergedAt: string;
  readonly files: readonly PrFile[];
  readonly datasetVersion: number;
}

export type CoherenceLabel = "coherent" | "incoherent";

/**
 * How an incoherent pair's foreign description was chosen (§ generateCoherencePairs
 * in pr-selection.ts): `"random"` is a seeded same-repo derangement (an easy
 * negative — the description is usually about a different area); `"hard"`
 * picks the most similar same-repo PR by change footprint, a near-duplicate
 * negative. Absent on coherent pairs and on any pair predating this field.
 */
export type CoherenceCrossingStrategy = "random" | "hard";

export interface CoherenceCrossing {
  readonly strategy: CoherenceCrossingStrategy;
  /** Jaccard similarity over touched-directory sets between the pair's two PRs. */
  readonly similarity: number;
  /** The PR whose description was crossed in; equals `descriptionPrId`. */
  readonly donorPr: string;
}

export interface CoherencePair {
  /** The PR whose files/diff form the CHANGE side of the state. */
  readonly prId: string;
  /** The PR whose title/body form the INTENT side; equals `prId` iff coherent. */
  readonly descriptionPrId: string;
  readonly label: CoherenceLabel;
  /** Present only for incoherent pairs produced by a strategy that records it (currently "hard"). */
  readonly crossing?: CoherenceCrossing;
}

export class PrRecordParseError extends Error {
  constructor(file: string, lineNumber: number, reason: string) {
    super(`${file} line ${lineNumber}: ${reason}`);
    this.name = "PrRecordParseError";
  }
}

const prFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(PR_FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

const prRecordSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  base_sha: z.string().min(1),
  head_sha: z.string().min(1),
  merged_at: z.string().min(1),
  files: z.array(prFileSchema),
  dataset_version: z.number().int().positive().default(1),
});

const coherenceCrossingSchema = z.object({
  strategy: z.enum(["random", "hard"]),
  similarity: z.number(),
  donor_pr: z.string().min(1),
});

const coherencePairSchema = z
  .object({
    pr_id: z.string().min(1),
    description_pr_id: z.string().min(1),
    label: z.enum(["coherent", "incoherent"]),
    crossing: coherenceCrossingSchema.optional(),
  })
  .refine((p) => (p.pr_id === p.description_pr_id) === (p.label === "coherent"), {
    path: ["label"],
    message: 'label must be "coherent" iff pr_id === description_pr_id',
  });

function issuesToReason(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<record>"}: ${i.message}`).join("; ");
}

function parseLines<T>(
  content: string,
  file: string,
  parseOne: (raw: unknown) => { success: true; data: T } | { success: false; error: z.ZodError },
): T[] {
  const out: T[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const lineNumber = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      throw new PrRecordParseError(file, lineNumber, `invalid JSON (${(error as Error).message})`);
    }
    const result = parseOne(raw);
    if (!result.success) {
      throw new PrRecordParseError(file, lineNumber, issuesToReason(result.error));
    }
    out.push(result.data);
  }
  return out;
}

export function parsePrRecordsJsonl(content: string, file = "prs.jsonl"): PrRecord[] {
  return parseLines(content, file, (raw) => {
    const result = prRecordSchema.safeParse(raw);
    if (!result.success) return result;
    const d = result.data;
    const record: PrRecord = {
      id: d.id,
      repo: d.repo,
      number: d.number,
      title: d.title,
      body: d.body,
      labels: d.labels,
      author: d.author,
      baseSha: d.base_sha,
      headSha: d.head_sha,
      mergedAt: d.merged_at,
      files: d.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch !== undefined ? { patch: f.patch } : {}),
      })),
      datasetVersion: d.dataset_version,
    };
    return { success: true, data: record };
  });
}

export function stringifyPrRecord(record: PrRecord): string {
  return JSON.stringify({
    id: record.id,
    repo: record.repo,
    number: record.number,
    title: record.title,
    body: record.body,
    labels: record.labels,
    author: record.author,
    base_sha: record.baseSha,
    head_sha: record.headSha,
    merged_at: record.mergedAt,
    files: record.files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
    })),
    dataset_version: record.datasetVersion,
  });
}

export function parseCoherencePairsJsonl(
  content: string,
  file = "coherence-pairs.jsonl",
): CoherencePair[] {
  return parseLines(content, file, (raw) => {
    const result = coherencePairSchema.safeParse(raw);
    if (!result.success) return result;
    const d = result.data;
    return {
      success: true,
      data: {
        prId: d.pr_id,
        descriptionPrId: d.description_pr_id,
        label: d.label,
        ...(d.crossing !== undefined
          ? {
              crossing: {
                strategy: d.crossing.strategy,
                similarity: d.crossing.similarity,
                donorPr: d.crossing.donor_pr,
              },
            }
          : {}),
      },
    };
  });
}

export function stringifyCoherencePair(pair: CoherencePair): string {
  return JSON.stringify({
    pr_id: pair.prId,
    description_pr_id: pair.descriptionPrId,
    label: pair.label,
    ...(pair.crossing !== undefined
      ? {
          crossing: {
            strategy: pair.crossing.strategy,
            similarity: pair.crossing.similarity,
            donor_pr: pair.crossing.donorPr,
          },
        }
      : {}),
  });
}
