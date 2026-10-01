/**
 * Candidate findings from one pipeline run (docs/EVAL.md "Buckets"): what
 * the author sees is `shown` — published findings, questions (needs-human),
 * the colleague review's bullet points and the secret warning — and what
 * the run kept out of sight is `low` (low-confidence and discarded).
 *
 * Narrative points are counted as their own candidates on purpose: the
 * narrative is what a reader actually reads first. A point that restates a
 * published finding matches the same golden issue, so recall is unchanged;
 * the shown-candidate counts say how much the reader had to read.
 *
 * Evidence-failed findings (`reviewer.requireEvidence`: none of their
 * quotes is in the code, `rejectedReason` set) are `low` with their own
 * source `evidence-failed`, whatever list they ended in: the run never
 * publishes them, and the report can tell them apart from Jev's
 * low-confidence calls. Agentic mode's other drops (hard exclusions, a
 * refuting verifier, a Jev discard — any other `rejectedReason`) are `low`
 * too, with source `dropped`.
 */
import {
  EVIDENCE_NOT_FOUND_REASON,
  type FilteredFinding,
} from "../pipeline/stages/finding-filter.js";
import type { CandidateFinding, CandidateSource } from "./candidate.js";

export interface PipelineCandidateInput {
  readonly findingFilter: {
    readonly published: readonly FilteredFinding[];
    readonly needsHuman: readonly FilteredFinding[];
    readonly lowConfidence: readonly FilteredFinding[];
    readonly discarded: readonly FilteredFinding[];
  } | null;
  readonly narrative: { readonly markdown: string | null } | null;
  readonly hunkProfile: {
    readonly hunks: readonly {
      readonly file: string;
      readonly newStart: number;
      readonly hunkHeader: string;
      readonly containsSecret: boolean;
    }[];
  } | null;
}

export interface NarrativePoint {
  readonly file: string | null;
  readonly line: number | null;
  readonly lineEnd?: number;
  readonly text: string;
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const REFERENCE_RE = /`([^`\s:]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`/;
/** Shorter bullets are verdict lines or labels, not review points. */
const MIN_POINT_LENGTH = 20;

/** The narrative's bullet points, each with its first `` `file:line` `` reference; stops at the details block. */
export function narrativePoints(markdown: string): NarrativePoint[] {
  const points: NarrativePoint[] = [];
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("<details")) break;
    const bullet = BULLET_RE.exec(line);
    const text = bullet?.[1]?.trim();
    if (text === undefined || text.length < MIN_POINT_LENGTH) continue;
    const reference = REFERENCE_RE.exec(text);
    if (reference) {
      const [, file, start, end] = reference as unknown as [string, string, string, string?];
      points.push({
        file,
        line: Number(start),
        ...(end !== undefined ? { lineEnd: Number(end) } : {}),
        text,
      });
    } else {
      points.push({ file: null, line: null, text });
    }
  }
  return points;
}

function toCandidate(
  f: FilteredFinding,
  id: string,
  source: CandidateSource,
  bucket: CandidateFinding["bucket"],
): CandidateFinding {
  return {
    id,
    file: f.file,
    line: f.lineStart,
    lineEnd: f.lineEnd,
    text: f.rationale ? `${f.claim} — ${f.rationale}` : f.claim,
    bucket,
    source,
  };
}

function fromFiltered(
  findings: readonly FilteredFinding[],
  caseId: string,
  source: CandidateSource,
  bucket: CandidateFinding["bucket"],
): CandidateFinding[] {
  return findings
    .filter((f) => f.rejectedReason === undefined)
    .map((f, index) => toCandidate(f, `${caseId}:${source}:${index}`, source, bucket));
}

function rejected(
  filter: PipelineCandidateInput["findingFilter"],
  caseId: string,
): CandidateFinding[] {
  const all = [
    ...(filter?.published ?? []),
    ...(filter?.needsHuman ?? []),
    ...(filter?.lowConfidence ?? []),
    ...(filter?.discarded ?? []),
  ].filter((f) => f.rejectedReason !== undefined);
  const evidence = all.filter((f) => f.rejectedReason === EVIDENCE_NOT_FOUND_REASON);
  // Agentic mode's other drops (hard exclusions, a refuting verifier, a
  // Jev discard): never shown, kept apart from evidence failures.
  const dropped = all.filter((f) => f.rejectedReason !== EVIDENCE_NOT_FOUND_REASON);
  return [
    ...evidence.map((f, index) =>
      toCandidate(f, `${caseId}:evidence-failed:${index}`, "evidence-failed", "low"),
    ),
    ...dropped.map((f, index) => toCandidate(f, `${caseId}:dropped:${index}`, "dropped", "low")),
  ];
}

export function candidatesFromPipeline(
  result: PipelineCandidateInput,
  caseId: string,
): CandidateFinding[] {
  const filter = result.findingFilter;
  const narrative =
    result.narrative?.markdown != null ? narrativePoints(result.narrative.markdown) : [];
  const secrets = (result.hunkProfile?.hunks ?? []).filter((h) => h.containsSecret);
  return [
    ...fromFiltered(filter?.published ?? [], caseId, "finding", "shown"),
    ...fromFiltered(filter?.needsHuman ?? [], caseId, "question", "shown"),
    ...narrative.map(
      (point, index): CandidateFinding => ({
        id: `${caseId}:narrative:${index}`,
        file: point.file,
        line: point.line,
        ...(point.lineEnd !== undefined ? { lineEnd: point.lineEnd } : {}),
        text: point.text,
        bucket: "shown",
        source: "narrative",
      }),
    ),
    ...secrets.map(
      (hunk, index): CandidateFinding => ({
        id: `${caseId}:secret:${index}`,
        file: hunk.file,
        line: hunk.newStart,
        text: `Possible committed secret in ${hunk.file} (${hunk.hunkHeader}): check it and rotate it if it is real.`,
        bucket: "shown",
        source: "secret",
      }),
    ),
    ...fromFiltered(filter?.lowConfidence ?? [], caseId, "low-confidence", "low"),
    ...fromFiltered(filter?.discarded ?? [], caseId, "discarded", "low"),
    ...rejected(filter, caseId),
  ];
}
