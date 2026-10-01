/**
 * Routing policy for agentic findings after Jev's staged judge
 * (`reviewer.mode: agentic`). Every constant that decides publish /
 * question / discard lives here, in one place, so a calibration study can
 * move them without touching the stages.
 *
 * Jev is good at JUDGING a concrete hypothesis against evidence, not at
 * finding bugs; the agent proposes, Jev decides through three typed steps,
 * each a separate request with an explicit escape hatch:
 *
 * 1. `supports` (choice proves / partially / noMatch): does the evidence,
 *    re-read from the working tree, support the claim and the failing
 *    scenario? `noMatch`, or any answer under
 *    {@link AGENTIC_SUPPORTS_MIN_CONFIDENCE}, discards.
 * 2. `mechanism` (choice per category, with `noIssue`): `noIssue` discards.
 * 3. `severity` (score 0..3): under {@link AGENTIC_MIN_SEVERITY} discards.
 *
 * Then: publish when `supports` is `proves` at or above
 * {@link AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE} and the optional LLM
 * verifier did not answer `uncertain`; a question when `supports` is
 * `partially`, `proves` under the publish bar, or the verifier was
 * uncertain. A `refuted` verifier answer never reaches this function (the
 * stage drops it first).
 *
 * FR-5.4 carries over: a finding the reviewer rated `critical` is never
 * discarded on Jev's judgment alone; it becomes a question instead.
 *
 * Pure: no ports, no I/O.
 */
import type { AgenticSeverity } from "./agentic-finding.js";

/** Below this `supports` confidence the finding is a question, whatever Jev picked. */
export const AGENTIC_SUPPORTS_MIN_CONFIDENCE = 0.55;
/** `proves` at or above this confidence can be published; below it is a question. */
export const AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE = 0.7;
/** Jev's expected severity score (0 none, 1 minor, 2 significant, 3 critical) must reach this. */
export const AGENTIC_MIN_SEVERITY = 1;

export type SupportsChoice = "proves" | "partially" | "noMatch";
export type VerifierDecision = "confirmed" | "refuted" | "uncertain";

export interface AgenticRouteInput {
  readonly supports: { readonly choice: string; readonly confidence: number };
  /** Absent (or undefined) until the step is asked. */
  readonly mechanism?: { readonly choice: string; readonly confidence: number } | undefined;
  readonly severity?: { readonly score: number; readonly confidence: number } | undefined;
  /** The LLM verifier's answer; "none" when `reviewer.verifier` is off. */
  readonly verifier: VerifierDecision | "none";
  readonly agentSeverity: AgenticSeverity;
}

/** Stable key per outcome, for the run's drops-by-reason metrics. */
export type AgenticRouteCode =
  | "supports-noMatch"
  | "supports-low-confidence"
  | "mechanism-noIssue"
  | "severity-low"
  | "partial-support"
  | "support-under-publish-bar"
  | "verifier-uncertain"
  | "verifier-confirmed"
  | "supported";

export interface AgenticRoute {
  readonly route: "publish" | "question" | "discard";
  readonly code: AgenticRouteCode;
  readonly reason: string;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A Jev doubt: a question, never a discard. Measured on a private golden
 * set: of the findings the staged judge discarded, none was false (3 real,
 * 6 partly), while the LLM verifier removed false ones without losing a
 * real one. So Jev routes between publish and question; discards come only
 * from hard exclusions, unverified evidence and a refuting verifier.
 */
function doubt(code: AgenticRouteCode, reason: string): AgenticRoute {
  return { route: "question", code, reason };
}

/** Reviewer severities that a verifier confirmation can publish. */
const PUBLISHABLE_AGENT_SEVERITIES: ReadonlySet<AgenticSeverity> = new Set([
  "medium",
  "high",
  "critical",
]);

/**
 * The route once enough of the chain is answered, or `"next"` when the
 * next Jev step is needed (the stage asks steps in order and stops at the
 * first doubt).
 */
export function routeAgenticFinding(input: AgenticRouteInput): AgenticRoute | "next" {
  const { supports, mechanism, severity, agentSeverity } = input;
  if (supports.choice === "noMatch") {
    return doubt(
      "supports-noMatch",
      "Jev found the evidence does not support the claim (supports: noMatch)",
    );
  }
  if (supports.confidence < AGENTIC_SUPPORTS_MIN_CONFIDENCE) {
    return doubt(
      "supports-low-confidence",
      `Jev was unsure the evidence supports the claim (supports: ${supports.choice} at confidence ${round(supports.confidence)})`,
    );
  }
  if (mechanism === undefined) return "next";
  if (mechanism.choice === "noIssue") {
    return doubt(
      "mechanism-noIssue",
      "Jev found no concrete issue mechanism in the evidence (mechanism: noIssue)",
    );
  }
  if (severity === undefined) return "next";
  if (severity.score < AGENTIC_MIN_SEVERITY) {
    return doubt(
      "severity-low",
      `Jev rated the impact below minor (severity ${round(severity.score)})`,
    );
  }
  if (input.verifier === "uncertain") {
    return doubt("verifier-uncertain", "the verifier could not confirm it against the code");
  }
  if (input.verifier === "confirmed") {
    if (PUBLISHABLE_AGENT_SEVERITIES.has(agentSeverity)) {
      return {
        route: "publish",
        code: "verifier-confirmed",
        reason: `confirmed by the verifier against the code, mechanism ${mechanism.choice}, rated ${agentSeverity}`,
      };
    }
    return doubt("severity-low", `confirmed by the verifier but rated ${agentSeverity}`);
  }
  if (supports.choice !== "proves") {
    return doubt("partial-support", "the evidence only partially supports the claim");
  }
  if (supports.confidence < AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE) {
    return doubt(
      "support-under-publish-bar",
      `Jev's support (${round(supports.confidence)}) is under the publish bar (${AGENTIC_PUBLISH_MIN_SUPPORTS_CONFIDENCE})`,
    );
  }
  return {
    route: "publish",
    code: "supported",
    reason: `supported by the evidence (${round(supports.confidence)}), mechanism ${mechanism.choice}, severity ${round(severity.score)}`,
  };
}
