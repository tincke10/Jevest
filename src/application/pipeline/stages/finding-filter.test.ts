import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import type { ConfidencePolicyConfig } from "../../../domain/confidence-policy.js";
import type { Decision } from "../../../domain/decision.js";
import type { ReviewFindingCandidate } from "../../../domain/ports/reviewer-port.js";
import { runFindingFilterStage } from "./finding-filter.js";
import type { ReviewStageEntry } from "./review.js";

const policyConfig: ConfidencePolicyConfig = {
  finding_filter: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
  },
};

function candidate(overrides: Partial<ReviewFindingCandidate> = {}): ReviewFindingCandidate {
  return {
    lineStart: 10,
    lineEnd: 12,
    claim: "off-by-one",
    rationale: "uses <= instead of <",
    suggestedSeverity: "major",
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewStageEntry> = {}): ReviewStageEntry {
  return {
    hunkId: "a.ts#0",
    file: "a.ts",
    findings: [candidate()],
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 500,
    requestId: "rev1",
    costUsd: 0.001,
    error: null,
    ...overrides,
  };
}

function scriptFor(
  findingId: string,
  isReal: number,
  severity: number,
  styleOnly: number,
  actionable: number,
): Record<string, Decision> {
  return {
    [`${findingId}__is_real_defect`]: { type: "noul", noul: isReal },
    [`${findingId}__severity`]: {
      type: "score",
      score: severity,
      confidence: 0.8,
      legend: { 0: "nit", 1: "minor", 2: "major", 3: "critical" },
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.7, 3: 0.1 },
    },
    [`${findingId}__is_style_only`]: { type: "noul", noul: styleOnly },
    [`${findingId}__actionable`]: { type: "noul", noul: actionable },
  };
}

const hunksById = new Map([["a.ts#0", "@@ -1,2 +1,2 @@\n-a\n+b"]]);

describe("runFindingFilterStage", () => {
  it("publishes a finding when confidently real (auto band)", async () => {
    const review = makeReview();
    // finding id is deterministic: "<hunkId>-f0"
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.95, 2, 0.05, 0.9));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.published).toHaveLength(1);
    expect(result.needsHuman).toHaveLength(0);
    expect(result.discarded).toHaveLength(0);
    expect(result.lowConfidence).toHaveLength(0);
    expect(result.published[0]!.claim).toBe("off-by-one");
  });

  it("sends a finding to needsHuman when confidence is in the confirm band", async () => {
    const review = makeReview();
    // isReal=0.85 -> noul confidence = |0.85-0.5|*2 = 0.7, within [confirmMin=0.6, autoMin=0.9).
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.85, 1, 0.1, 0.6));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.needsHuman).toHaveLength(1);
    expect(result.published).toHaveLength(0);
    expect(result.discarded).toHaveLength(0);
    expect(result.lowConfidence).toHaveLength(0);
  });

  it("discards a finding confidently classified as noise (escalate band, non-critical) in discard mode", async () => {
    const review = makeReview();
    // isReal=0.5 -> noul confidence = |0.5-0.5|*2 = 0 -> escalate band; predictedReal = 0.5>=0.5 = true actually...
    // use a value clearly on the "not real" side with low confidence: isReal=0.55 -> confidence=0.1 -> escalate, predictedReal=true (>=0.5)
    // To get escalate + predictedReal=false, use isReal < 0.5 with low confidence, e.g. 0.45 -> confidence=0.1 -> escalate, predictedReal=false
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.45, 0, 0.6, 0.2));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.discarded).toHaveLength(1);
    expect(result.published).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(0);
    expect(result.lowConfidence).toHaveLength(0);
  });

  it("routes a finding that would have been discarded into lowConfidence instead, in annotate mode (product decision 2026-09-22, H1 pending)", async () => {
    const review = makeReview();
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.45, 0, 0.6, 0.2));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "annotate",
    });

    expect(result.discarded).toHaveLength(0);
    expect(result.published).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(0);
    expect(result.lowConfidence).toHaveLength(1);
    expect(result.lowConfidence[0]!.claim).toBe("off-by-one");
    expect(result.lowConfidence[0]!.isRealDefectProb).toBe(0.45);
  });

  it("never discards a critical-severity finding, even at escalate-band confidence (FR-5.4)", async () => {
    const review = makeReview();
    // isReal=0.45 (confidence 0.1, escalate, predictedReal=false) but Jev's own severity score rounds to 3 (critical).
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.45, 3, 0.6, 0.2));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.discarded).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
  });

  it("never puts a critical-severity finding in lowConfidence either, in annotate mode (FR-5.4)", async () => {
    const review = makeReview();
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.45, 3, 0.6, 0.2));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "annotate",
    });

    expect(result.lowConfidence).toHaveLength(0);
    expect(result.discarded).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
  });

  it("never discards a finding the REVIEWER marked critical, even when Jev's own severity is lower (FR-5.4, H5)", async () => {
    const review = makeReview({ findings: [candidate({ suggestedSeverity: "critical" })] });
    // isReal=0.05 (confidently "not real"), Jev severity 2.3 (major): H5 showed
    // this exact shape discarding a planted critical defect.
    const port = createFakeDecisionAdapter(scriptFor("a.ts#0-f0", 0.05, 2.3, 0.6, 0.2));

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.discarded).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
  });

  it("only filters findings from reviews with no error", async () => {
    const reviews = [
      makeReview({ hunkId: "a.ts#0", findings: [] }),
      makeReview({ hunkId: "b.ts#0", error: "reviewer failed", findings: [candidate()] }),
    ];
    const port = createFakeDecisionAdapter({});
    const result = await runFindingFilterStage({
      reviews,
      hunksById: new Map([
        ["a.ts#0", "diff"],
        ["b.ts#0", "diff"],
      ]),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });
    expect(result.published).toEqual([]);
    expect(result.needsHuman).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(result.lowConfidence).toEqual([]);
    expect(result.totalRequests).toBe(0);
  });

  it("routes a finding to needsHuman, never drops it, when Jev fails to classify it (NFR-2 fail-closed)", async () => {
    const review = makeReview();
    // No script entry for "a.ts#0-f0" -> createFakeDecisionAdapter throws for it,
    // which filter-runner.ts records as a per-finding failure rather than a thrown error.
    const port = createFakeDecisionAdapter({});

    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });

    expect(result.published).toHaveLength(0);
    expect(result.discarded).toHaveLength(0);
    expect(result.lowConfidence).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
    expect(result.needsHuman[0]!.findingId).toBe("a.ts#0-f0");
    expect(result.needsHuman[0]!.claim).toBe("off-by-one");
  });

  it("issues one Jev request per finding (NFR-14)", async () => {
    const review = makeReview({
      findings: [candidate({ claim: "c1" }), candidate({ claim: "c2" })],
    });
    const script = {
      ...scriptFor("a.ts#0-f0", 0.95, 2, 0.05, 0.9),
      ...scriptFor("a.ts#0-f1", 0.95, 2, 0.05, 0.9),
    };
    const port = createFakeDecisionAdapter(script);
    const result = await runFindingFilterStage({
      reviews: [review],
      hunksById,
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      mode: "discard",
    });
    expect(result.totalRequests).toBe(2);
    expect(result.published).toHaveLength(2);
  });
});
