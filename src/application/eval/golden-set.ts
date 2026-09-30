/**
 * The golden set the review pipeline is measured against (docs/EVAL.md):
 * JSON Lines, one case per line, each a PR (a repo and two refs) plus the
 * issues an adjudicator verified against the code.
 *
 * Only `real` and `partly` issues are recall targets; `false` issues are
 * KNOWN-FALSE (a candidate review that shows one is showing known noise);
 * `unverifiable` issues count for nothing. `file`/`line` may be `null` when
 * the adjudication could not pin the issue to one place: such an issue is
 * matched by its title only.
 *
 * Client sets never live in this repo (docs/EVAL.md "Confidentiality").
 */
import { z } from "zod";

export const GOLDEN_SCHEMA_VERSION = 1;

export const GOLDEN_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type GoldenSeverity = (typeof GOLDEN_SEVERITIES)[number];

export const GOLDEN_VERDICTS = ["real", "partly", "false", "unverifiable"] as const;
export type GoldenVerdict = (typeof GOLDEN_VERDICTS)[number];

export interface GoldenLocation {
  readonly file: string;
  readonly line: number;
}

export interface GoldenIssue {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly lineEnd?: number;
  /** Other places the issue shows up (the caller, the broken test, …); used by the matcher's pre-filter. */
  readonly locations?: readonly GoldenLocation[];
  readonly title: string;
  readonly severity: GoldenSeverity;
  readonly verdict: GoldenVerdict;
  readonly category?: string;
  readonly notes?: string;
}

export interface GoldenCase {
  readonly schema: typeof GOLDEN_SCHEMA_VERSION;
  readonly id: string;
  /** A git repository (a bare mirror is enough) that has both refs. */
  readonly repoPath: string;
  /** Commit SHAs (or refs) — SHAs keep a set reproducible after branches move. */
  readonly baseRef: string;
  readonly headRef: string;
  readonly title: string;
  readonly description: string;
  readonly issues: readonly GoldenIssue[];
}

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenSetError";
  }
}

const locationSchema = z.object({ file: z.string().min(1), line: z.number().int().min(0) });

const issueSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1).nullable(),
  line: z.number().int().min(0).nullable(),
  lineEnd: z.number().int().min(0).optional(),
  locations: z.array(locationSchema).optional(),
  title: z.string().min(1),
  severity: z.enum(GOLDEN_SEVERITIES),
  verdict: z.enum(GOLDEN_VERDICTS),
  category: z.string().optional(),
  notes: z.string().optional(),
});

const caseSchema = z.object({
  schema: z.literal(GOLDEN_SCHEMA_VERSION),
  id: z.string().min(1),
  repoPath: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  title: z.string(),
  description: z.string(),
  issues: z.array(issueSchema),
});

export function parseGoldenCase(value: unknown, label: string): GoldenCase {
  const parsed = caseSchema.safeParse(value);
  if (!parsed.success) {
    throw new GoldenSetError(`${label}: ${parsed.error.message}`);
  }
  const seen = new Set<string>();
  for (const issue of parsed.data.issues) {
    if (seen.has(issue.id)) {
      throw new GoldenSetError(`${label}: duplicate issue id "${issue.id}"`);
    }
    seen.add(issue.id);
  }
  return parsed.data as GoldenCase;
}

export function parseGoldenSetJsonl(content: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const ids = new Set<string>();
  content.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    const label = `golden set line ${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new GoldenSetError(`${label}: invalid JSON (${(error as Error).message})`);
    }
    const goldenCase = parseGoldenCase(json, label);
    if (ids.has(goldenCase.id)) {
      throw new GoldenSetError(`${label}: duplicate case id "${goldenCase.id}"`);
    }
    ids.add(goldenCase.id);
    cases.push(goldenCase);
  });
  return cases;
}

export function stringifyGoldenCase(goldenCase: GoldenCase): string {
  return JSON.stringify(goldenCase);
}
