/**
 * Port for the optional per-finding LLM verifier (`reviewer.verifier`,
 * agentic mode only): a FRESH agent, same read-only tools and deny list as
 * the reviewer, asked to try to REFUTE one finding against the code.
 * `refuted` drops the finding, `uncertain` caps it at a question,
 * `confirmed` lets it continue to Jev's judge. Zero SDK imports.
 */
import type { AgenticFinding } from "../agentic-finding.js";
import type { VerifierDecision } from "../agentic-policy.js";
import type { EvidenceItem } from "../evidence-verifier.js";
import type { AgentRunInfo } from "./agentic-reviewer-port.js";

export interface FindingVerificationInput {
  /** `owner/repo#number:<finding id>`, for error messages and logs only. */
  readonly itemId: string;
  /** Absolute path of the checkout of the PR head: the agent's cwd. */
  readonly repoRoot: string;
  /** Redacted. */
  readonly finding: AgenticFinding;
  readonly changedFiles: readonly string[];
}

export interface FindingVerificationOutput extends AgentRunInfo {
  readonly decision: VerifierDecision;
  /** Redacted. */
  readonly reason: string;
  readonly evidence: readonly EvidenceItem[];
}

export interface FindingVerifierPort {
  verify(input: FindingVerificationInput): Promise<FindingVerificationOutput>;
}
