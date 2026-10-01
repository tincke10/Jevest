/**
 * A finding from the agentic reviewer (`reviewer.mode: agentic`): one
 * agent per PR reads the diff and the repository at the PR head with
 * read-only tools and reports what it verified in the code. Unlike the
 * per-hunk reviewer, lines are HEAD-side (the file as it is after the
 * change), a finding may be about code outside the diff as long as its
 * evidence cites the changed code that causes it, and every finding names
 * a concrete failing scenario.
 *
 * Pure: no ports, no I/O.
 */
import type { EvidenceItem } from "./evidence-verifier.js";
import { redact } from "./redact.js";

/** What the agent may report. Style, docs, naming and lint-catchable issues are out of scope. */
export const AGENTIC_CATEGORIES = [
  "correctness",
  "security",
  "regression",
  "reliability",
  "tests",
] as const;
export type AgenticCategory = (typeof AGENTIC_CATEGORIES)[number];

export const AGENTIC_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type AgenticSeverity = (typeof AGENTIC_SEVERITIES)[number];

export interface AgenticFinding {
  /** Repo-relative path the finding is about. */
  readonly file: string;
  /** HEAD-side line. */
  readonly line: number;
  readonly lineEnd?: number;
  readonly category: AgenticCategory;
  readonly severity: AgenticSeverity;
  readonly claim: string;
  /** Concrete input or state -> the wrong result it produces. */
  readonly failingScenario: string;
  /** 1–3 exact quotes (≤ 200 chars) that prove the claim. */
  readonly evidence: readonly EvidenceItem[];
  /** The agent's own confidence, 0..1. Reported, not used to route. */
  readonly confidence: number;
}

/**
 * NFR-3 on the way OUT: the agent reads repository files directly, so its
 * text may quote a secret. Everything Jevest sends on (to Jev, to the
 * verifier, to the narrator, to the PR) is redacted here first.
 */
export function redactAgenticFinding(finding: AgenticFinding): AgenticFinding {
  const text = (value: string, path?: string): string =>
    redact(value, path === undefined ? {} : { path }).text;
  return {
    ...finding,
    claim: text(finding.claim),
    failingScenario: text(finding.failingScenario),
    evidence: finding.evidence.map((item) => ({ ...item, quote: text(item.quote, item.file) })),
  };
}
