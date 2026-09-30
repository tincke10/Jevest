/**
 * Turns adjudication files into golden cases (docs/EVAL.md "Building a set
 * from adjudications"). An adjudication lists issues with an id, a title, a
 * verdict (real | partly | false | unverifiable), a severity and free-text
 * evidence, but no location; a follow-up adjudication may add `new_issues`.
 *
 * Locations come from, in order: a matching finding of an "anchor" review
 * (an import-format review whose finding text covers the issue title —
 * that reviewer found it, so its file:line is where it lives), then the
 * `file:line` references in the evidence and the title, resolved against
 * the head tree (path suffix, base name preferring changed files, or an
 * extensionless class name). Every other resolved reference becomes an
 * extra location. An issue with none keeps `file: null` and is matched by
 * title only.
 */
import {
  GOLDEN_SCHEMA_VERSION,
  GOLDEN_VERDICTS,
  type GoldenCase,
  type GoldenIssue,
  type GoldenLocation,
  type GoldenSeverity,
  type GoldenVerdict,
} from "./golden-set.js";
import { titleCoverage } from "./prefilter.js";

export interface AdjudicationIssue {
  readonly id: string;
  readonly title: string;
  readonly verdict: string;
  readonly severity: string | null;
  readonly evidence?: string;
  readonly found_by?: string;
  readonly local_kind?: string | null;
}

export interface AdjudicationFile {
  readonly issues?: readonly AdjudicationIssue[];
  readonly new_issues?: readonly AdjudicationIssue[];
}

export interface CaseRepoInfo {
  readonly repoPath: string;
  readonly baseRef: string;
  readonly headRef: string;
  /** Every path in the head tree. */
  readonly files: readonly string[];
  /** Paths the change touches; preferred when a base name is ambiguous. */
  readonly changedFiles: readonly string[];
}

export interface AnchorFinding {
  readonly file: string;
  readonly line: number | null;
  readonly text: string;
}

export interface ConvertAdjudicationInput {
  readonly caseId: string;
  readonly v1: AdjudicationFile;
  readonly v2?: AdjudicationFile;
  readonly meta: { readonly title: string; readonly body: string };
  readonly repo: CaseRepoInfo;
  readonly anchors?: readonly AnchorFinding[];
}

/** Minimum share of the issue title's words a finding must cover to anchor it. */
export const ANCHOR_MIN_COVERAGE = 0.5;

const SEVERITY_MAP: Readonly<Record<string, GoldenSeverity>> = {
  critical: "critical",
  blocker: "critical",
  high: "high",
  major: "high",
  medium: "medium",
  low: "low",
  minor: "low",
  nit: "low",
};

export interface FileRef {
  readonly name: string;
  readonly line: number;
  readonly lineEnd?: number;
}

const FILE_REF_RE = /(?<![\w./:-])([A-Za-z_][\w.-]*(?:\/[\w.-]+)*):(\d+)(?:-(\d+))?/g;

export function extractFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  for (const match of text.matchAll(FILE_REF_RE)) {
    const [, name, start, end] = match as unknown as [string, string, string, string?];
    refs.push({
      name,
      line: Number(start),
      ...(end !== undefined ? { lineEnd: Number(end) } : {}),
    });
  }
  return refs;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stemOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function pick(matches: readonly string[], changed: ReadonlySet<string>): string | null {
  if (matches.length === 0) return null;
  return (
    matches.find((m) => changed.has(m)) ?? (matches.length === 1 ? (matches[0] as string) : null)
  );
}

export function resolveFileRef(
  name: string,
  files: readonly string[],
  changedFiles: readonly string[],
): string | null {
  const changed = new Set(changedFiles);
  if (name.includes("/")) {
    const bySuffix = pick(
      files.filter((f) => f === name || f.endsWith(`/${name}`)),
      changed,
    );
    if (bySuffix !== null) return bySuffix;
  }
  const base = baseName(name);
  if (base.includes(".")) {
    const exact = pick(
      files.filter((f) => baseName(f) === base),
      changed,
    );
    if (exact !== null) return exact;
    // An abbreviated name (`spec.js:12` for `checkout.spec.js`): only when
    // exactly one CHANGED file ends with it.
    const abbreviated = changedFiles.filter((f) => baseName(f).endsWith(`.${base}`));
    return abbreviated.length === 1 ? (abbreviated[0] as string) : null;
  }
  return pick(
    files.filter((f) => stemOf(baseName(f)) === base),
    changed,
  );
}

function toSeverity(raw: string | null): GoldenSeverity {
  if (raw === null) return "low";
  return SEVERITY_MAP[raw.toLowerCase()] ?? "low";
}

function toVerdict(raw: string, label: string): GoldenVerdict {
  if ((GOLDEN_VERDICTS as readonly string[]).includes(raw)) return raw as GoldenVerdict;
  throw new Error(`${label}: unknown verdict "${raw}" (expected ${GOLDEN_VERDICTS.join(", ")})`);
}

function convertIssue(issue: AdjudicationIssue, input: ConvertAdjudicationInput): GoldenIssue {
  const label = `${input.caseId} ${issue.id}`;
  const verdict = toVerdict(issue.verdict, label);
  const refs = [...extractFileRefs(issue.evidence ?? ""), ...extractFileRefs(issue.title)];
  const resolved: (GoldenLocation & { lineEnd?: number })[] = [];
  for (const ref of refs) {
    const file = resolveFileRef(ref.name, input.repo.files, input.repo.changedFiles);
    if (file === null) continue;
    if (resolved.some((r) => r.file === file && r.line === ref.line)) continue;
    resolved.push({
      file,
      line: ref.line,
      ...(ref.lineEnd !== undefined ? { lineEnd: ref.lineEnd } : {}),
    });
  }

  let best: AnchorFinding | null = null;
  let bestCoverage = ANCHOR_MIN_COVERAGE;
  for (const anchor of input.anchors ?? []) {
    const coverage = titleCoverage(issue.title, anchor.text);
    if (coverage >= bestCoverage && (best === null || coverage > bestCoverage)) {
      best = anchor;
      bestCoverage = coverage;
    }
  }

  let primary: (GoldenLocation & { lineEnd?: number }) | null = null;
  let rest = resolved;
  if (best !== null) {
    primary = { file: best.file, line: best.line ?? 0 };
  } else if (resolved.length > 0) {
    primary = resolved[0] ?? null;
    rest = resolved.slice(1);
  }
  const locations = rest
    .filter((r) => primary === null || r.file !== primary.file || r.line !== primary.line)
    .map((r) => ({ file: r.file, line: r.line }));

  const notes = [
    issue.found_by ? `found_by=${issue.found_by}` : null,
    issue.severity !== null && toSeverity(issue.severity) !== issue.severity
      ? `adjudicated severity=${issue.severity}`
      : null,
    issue.evidence ?? null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join("; ");

  return {
    id: issue.id,
    file: primary?.file ?? null,
    line: primary === null ? null : primary.line,
    ...(primary?.lineEnd !== undefined ? { lineEnd: primary.lineEnd } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    title: issue.title,
    severity: toSeverity(issue.severity),
    verdict,
    ...(issue.local_kind ? { category: issue.local_kind } : {}),
    ...(notes !== "" ? { notes } : {}),
  };
}

export function convertAdjudication(input: ConvertAdjudicationInput): GoldenCase {
  const raw = [...(input.v1.issues ?? []), ...(input.v2?.new_issues ?? [])];
  const seen = new Set<string>();
  const issues: GoldenIssue[] = [];
  for (const issue of raw) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    issues.push(convertIssue(issue, input));
  }
  return {
    schema: GOLDEN_SCHEMA_VERSION,
    id: input.caseId,
    repoPath: input.repo.repoPath,
    baseRef: input.repo.baseRef,
    headRef: input.repo.headRef,
    title: input.meta.title,
    description: input.meta.body,
    issues,
  };
}
