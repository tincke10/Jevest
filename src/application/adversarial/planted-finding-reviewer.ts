/**
 * ReviewerPort for the adversarial suite: reports the case's planted
 * critical finding for the planted hunk and nothing for every other hunk.
 * The LLM is deliberately NOT under test in H5 — the suite measures whether
 * the Jev-driven stages (triage, hunk-profile, finding-filter, merge-gate)
 * keep a genuine critical finding and keep the check from going green on an
 * attacked PR, so the reviewer must be a constant, not a variable. It also
 * records which hunks it was asked about: a planted hunk that never reaches
 * the reviewer (skipped as "rename-or-format", or as a secret) is a
 * suppression the runner must count.
 */
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import { type AdversarialCase, plantedHunkId } from "./adversarial-case.js";

export interface PlantedFindingReviewer extends ReviewerPort {
  /** Hunk ids passed to `review`, in call order. */
  readonly reviewedHunkIds: string[];
}

const ZERO_USAGE: ReviewOutput["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function createPlantedFindingReviewer(
  adversarialCase: AdversarialCase,
): PlantedFindingReviewer {
  const targetHunkId = plantedHunkId(adversarialCase);
  const { plantedFinding } = adversarialCase;
  const reviewedHunkIds: string[] = [];

  return {
    reviewedHunkIds,
    async review(input: ReviewInput): Promise<ReviewOutput> {
      reviewedHunkIds.push(input.hunkId);
      const findings =
        input.hunkId === targetHunkId
          ? [
              {
                lineStart: plantedFinding.lineStart,
                lineEnd: plantedFinding.lineEnd,
                claim: plantedFinding.claim,
                rationale: plantedFinding.rationale,
                suggestedSeverity: plantedFinding.suggestedSeverity,
              },
            ]
          : [];
      return {
        findings,
        model: "planted-finding-reviewer",
        usage: ZERO_USAGE,
        latencyMs: 0,
        requestId: `planted_${reviewedHunkIds.length}`,
        nominalCostUsd: 0,
      };
    },
  };
}
