import {
  type ConfidencePolicyConfig,
  createConfidencePolicy,
} from "../../../domain/confidence-policy.js";
import type { Usage } from "../../../domain/decision.js";
import type { DecisionPort } from "../../../domain/ports/decision-port.js";
/**
 * Stage 5: merge gate (SPEC FR-6). One Jev request for the whole PR
 * (NFR-14). Unlike `is_real_defect` in finding-filter, `safe_to_automerge`
 * is one-directional, not symmetric: FR-6.3 describes a single three-tier
 * axis (alta -> verde, media -> neutral, baja -> rojo), not two distinct
 * "confidently yes" / "confidently no" outcomes. So the raw probability is
 * banded directly (no `|p-0.5|*2` transform) — high probability of safety
 * *is* the confidence we act on. FR-6.4: this stage only emits a signal, it
 * never merges anything itself.
 */
import type { NoulQuestion } from "../../../domain/question.js";
import type { RiskLevel } from "./triage.js";

function safeToAutomergeQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Based on the triage summary, the findings published from reviewing this pull request, and its CI status, is it safe to automatically merge this pull request without further human review?",
    criteria: {
      true: "Published findings are minor or none, CI passed, and nothing here suggests risk beyond what has already been reviewed.",
      false:
        "There are unresolved major or critical findings, CI has not passed, or the risk profile calls for a human to decide.",
    },
  };
}

export interface MergeGateStageInput {
  readonly decisionPort: DecisionPort;
  readonly policyConfig: ConfidencePolicyConfig;
  readonly riskLevel: RiskLevel;
  readonly triageCategory: string;
  readonly publishedCountsBySeverity: Readonly<Record<string, number>>;
  readonly ciStatus: "success" | "failure" | "pending" | "unknown";
  /** FR-6.3: computed by the caller from triage's own containsInjectedInstructionsProb + threshold. */
  readonly containsInjectedInstructionsHigh: boolean;
}

export interface MergeGateStageResult {
  readonly safeToAutomergeProb: number;
  readonly conclusion: "success" | "neutral" | "failure";
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export async function runMergeGateStage(input: MergeGateStageInput): Promise<MergeGateStageResult> {
  const state = {
    triage_category: input.triageCategory,
    published_findings_by_severity: input.publishedCountsBySeverity,
    ci_status: input.ciStatus,
  };

  const response = await input.decisionPort.decide(state, {
    safe_to_automerge: safeToAutomergeQuestion(),
  });

  const safe = response.answers.safe_to_automerge;
  if (safe.type !== "noul") {
    throw new Error("merge-gate: unexpected decision shape from DecisionPort");
  }

  let conclusion: MergeGateStageResult["conclusion"];
  if (input.containsInjectedInstructionsHigh) {
    // FR-6.3: a suspected prompt injection in the PR fails the gate
    // regardless of how safe the model otherwise judges the merge to be.
    conclusion = "failure";
  } else {
    const policy = createConfidencePolicy(input.policyConfig);
    const band = policy.band("merge_gate", input.riskLevel, safe.noul);
    conclusion = band === "auto" ? "success" : band === "confirm" ? "neutral" : "failure";
  }

  return {
    safeToAutomergeProb: safe.noul,
    conclusion,
    requestId: response.requestId,
    latencyMs: response.latencyMs,
    usage: response.usage,
  };
}
