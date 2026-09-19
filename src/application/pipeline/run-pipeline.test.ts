import { describe, expect, it } from "vitest";
import type { JevestConfig } from "../../adapters/config/jevest-config.js";
import type { ConfidencePolicyConfig } from "../../domain/confidence-policy.js";
import type { Decision } from "../../domain/decision.js";
import type { DecisionPort } from "../../domain/ports/decision-port.js";
import type { ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";
import type { VcsPort } from "../../domain/ports/vcs-port.js";
import type { PullRequestData, PullRequestRef } from "../../domain/pull-request.js";
import { runPipeline } from "./run-pipeline.js";

const ref: PullRequestRef = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  headSha: "head",
  baseSha: "base",
};

function makePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    ref,
    title: "Fix off-by-one",
    body: "Fixes a bug in the loop bound.",
    author: "dev",
    labels: [],
    baseBranch: "main",
    files: [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      },
    ],
    ciStatus: "success",
    ...overrides,
  };
}

const policyConfig: ConfidencePolicyConfig = {
  triage: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
    medium: { autoMin: 0.95, confirmMin: 0.7 },
    high: { autoMin: 0.98, confirmMin: 0.8 },
  },
  hunk_profile: {
    low: { autoMin: 0.85, confirmMin: 0.55 },
    medium: { autoMin: 0.9, confirmMin: 0.65 },
  },
  finding_filter: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
    medium: { autoMin: 0.93, confirmMin: 0.68 },
  },
  merge_gate: {
    low: { autoMin: 0.9, confirmMin: 0.6 },
    medium: { autoMin: 0.97, confirmMin: 0.8 },
  },
};

function makeConfig(overrides: Partial<JevestConfig> = {}): JevestConfig {
  return {
    reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
    thresholds: policyConfig,
    sizeThresholds: { smallMaxChangedLines: 50, mediumMaxChangedLines: 300 },
    budgetUsd: 5,
    maxHunks: 50,
    skipChangeKinds: ["rename-or-format"],
    failClosed: true,
    ...overrides,
  };
}

function makeVcs(pr: PullRequestData): VcsPort & { published: unknown[] } {
  const published: unknown[] = [];
  return {
    published,
    async fetchPullRequest() {
      return pr;
    },
    async publishReview(_ref, publication) {
      published.push(publication);
    },
  };
}

function fakeReviewer(findings: ReviewOutput["findings"] = []): ReviewerPort {
  return {
    async review() {
      return {
        findings,
        model: "claude-sonnet-5",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        latencyMs: 100,
        requestId: "rev1",
      };
    },
  };
}

/** A DecisionPort scripted per question-key regardless of item, sufficient when only one item flows through each stage. */
function scriptedPort(script: Record<string, Decision>): DecisionPort {
  let counter = 0;
  return {
    async decide(_state: unknown, questions: Record<string, unknown>) {
      const answers: Record<string, Decision> = {};
      for (const key of Object.keys(questions)) {
        const decision = script[key];
        if (!decision) throw new Error(`no script for "${key}"`);
        answers[key] = decision;
      }
      counter += 1;
      return {
        requestId: `req_${counter}`,
        model: "fake",
        latencyMs: 5,
        usage: { inputTokens: 1, outputTokens: 1 },
        answers,
      };
    },
  } as DecisionPort;
}

const HIGH_RISK_TRIAGE_SCRIPT: Record<string, Decision> = {
  category: {
    type: "choice",
    choice: "bugfix",
    confidence: 0.9,
    probabilities: { bugfix: 0.9 },
  },
  risk: {
    type: "score",
    score: 1,
    confidence: 0.95,
    legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
    probabilities: { 0: 0.05, 1: 0.9, 2: 0.03, 3: 0.01, 4: 0.01 },
  },
  needs_human: { type: "noul", noul: 0.05 },
  contains_injected_instructions: { type: "noul", noul: 0.02 },
};

describe("runPipeline", () => {
  it("runs all six stages end to end and publishes the result via VcsPort", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const decision = scriptedPort({
      ...HIGH_RISK_TRIAGE_SCRIPT,
      // Force a non-skippable risk so the full pipeline runs (low risk with high confidence would skip per FR-2.3).
      risk: {
        type: "score",
        score: 2,
        confidence: 0.95,
        legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
        probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.05, 4: 0.02 },
      },
      change_kind: {
        type: "choice",
        choice: "modify-behavior",
        confidence: 0.9,
        probabilities: { "modify-behavior": 0.9 },
      },
      touches_error_handling: { type: "noul", noul: 0.1 },
      touches_async: { type: "noul", noul: 0.1 },
      "a.ts#0-f0__is_real_defect": { type: "noul", noul: 0.99 },
      "a.ts#0-f0__severity": {
        type: "score",
        score: 2,
        confidence: 0.8,
        legend: { 0: "nit", 1: "minor", 2: "major", 3: "critical" },
        probabilities: { 0: 0.1, 1: 0.1, 2: 0.7, 3: 0.1 },
      },
      "a.ts#0-f0__is_style_only": { type: "noul", noul: 0.05 },
      "a.ts#0-f0__actionable": { type: "noul", noul: 0.9 },
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });
    const reviewer = fakeReviewer([
      {
        lineStart: 1,
        lineEnd: 1,
        claim: "off-by-one",
        rationale: "uses <= instead of <",
        suggestedSeverity: "major",
      },
    ]);

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer },
      config: makeConfig(),
    });

    expect(result.failedClosed).toBe(false);
    expect(result.triage).not.toBeNull();
    expect(result.hunkProfile).not.toBeNull();
    expect(result.review).not.toBeNull();
    expect(result.findingFilter).not.toBeNull();
    expect(result.mergeGate).not.toBeNull();
    expect(result.publication.inlineComments).toHaveLength(1);
    expect(vcs.published).toHaveLength(1);
    // Convenience top-level mirrors for callers that just need the
    // CI-facing summary (src/action/main.ts) without the full stage breakdown.
    expect(result.check).toEqual(result.publication.check);
    expect(result.findingsPublished).toBe(result.findingFilter!.published.length);
    expect(result.costUsd).toBe(result.review!.totalCostUsd);
  });

  it("skips hunk-profile/review/finding-filter/merge-gate and publishes triage-only when FR-2.3 applies", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const decision = scriptedPort(HIGH_RISK_TRIAGE_SCRIPT);
    const reviewer = fakeReviewer();
    let reviewerCalled = false;
    const trackedReviewer: ReviewerPort = {
      review: async (input) => {
        reviewerCalled = true;
        return reviewer.review(input);
      },
    };

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer: trackedReviewer },
      config: makeConfig(),
    });

    expect(result.hunkProfile).toBeNull();
    expect(result.review).toBeNull();
    expect(result.findingFilter).toBeNull();
    expect(result.mergeGate).toBeNull();
    expect(reviewerCalled).toBe(false);
    expect(result.publication.check.conclusion).toBe("success");
    expect(result.check).toEqual(result.publication.check);
    expect(result.findingsPublished).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("fails closed when triage's Jev call fails, publishing a failure without running later stages (NFR-2)", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const decision = {
      decide: async () => {
        throw new Error("jev timeout");
      },
    };
    const reviewer = fakeReviewer();

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer },
      config: makeConfig(),
    });

    expect(result.failedClosed).toBe(true);
    expect(result.triage).toBeNull();
    expect(result.publication.check.conclusion).toBe("failure");
    expect(result.publication.inlineComments).toEqual([]);
    expect(vcs.published).toHaveLength(1);
    expect(result.check).toEqual(result.publication.check);
    expect(result.findingsPublished).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("does not fail the whole pipeline when Jev fails on one hunk during hunk-profile — that hunk still goes to review without a profile (NFR-2, per-hunk)", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    // Non-skippable risk (medium) so triage doesn't take the FR-2.3 shortcut
    // and the pipeline actually reaches hunk-profile.
    const triageScript: Record<string, Decision> = {
      ...HIGH_RISK_TRIAGE_SCRIPT,
      risk: {
        type: "score",
        score: 2,
        confidence: 0.95,
        legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
        probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.05, 4: 0.02 },
      },
    };
    let call = 0;
    const mergeGateOnlyPort = scriptedPort({
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });
    const decision = {
      decide: async (state: never, questions: never) => {
        call += 1;
        if (call === 1) {
          // triage call succeeds
          return scriptedPort(triageScript).decide(state, questions);
        }
        if (call === 2) {
          // hunk-profile's own request fails — runHunkProfileStage absorbs
          // this per-hunk (see hunk-profile.ts's profileFailed handling)
          // and does not throw, so the pipeline keeps going.
          throw new Error("jev down");
        }
        // finding-filter has nothing to classify (no findings from the
        // reviewer); merge-gate's own request succeeds normally.
        return mergeGateOnlyPort.decide(state, questions);
      },
    } as DecisionPort;
    const reviewer = fakeReviewer();

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer },
      config: makeConfig(),
    });

    expect(result.failedClosed).toBe(false);
    expect(result.triage).not.toBeNull();
    expect(result.hunkProfile).not.toBeNull();
    expect(result.hunkProfile!.hunks[0]!.profileFailed).toBe(true);
    expect(result.hunkProfile!.hunks[0]!.skippedFromReview).toBe(false);
    expect(result.review).not.toBeNull();
    expect(result.mergeGate).not.toBeNull();
  });

  it("fails closed when hunk-profile raises a genuine contract violation (e.g. Jev answers with the wrong decision shape)", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const triageScript: Record<string, Decision> = {
      ...HIGH_RISK_TRIAGE_SCRIPT,
      risk: {
        type: "score",
        score: 2,
        confidence: 0.95,
        legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
        probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.05, 4: 0.02 },
      },
    };
    let call = 0;
    const decision = {
      decide: async (state: never, questions: Record<string, unknown>) => {
        call += 1;
        if (call === 1) {
          return scriptedPort(triageScript).decide(state, questions as never);
        }
        // change_kind answered as the wrong decision type — a contract
        // violation, not a transient Jev outage; hunk-profile.ts throws for
        // this (outside its per-hunk try/catch), and run-pipeline.ts fails
        // the whole run closed rather than publishing on broken data.
        const answers: Record<string, Decision> = {};
        for (const key of Object.keys(questions)) {
          answers[key] = { type: "noul", noul: 0.5 };
        }
        return {
          requestId: "bad1",
          model: "fake",
          latencyMs: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          answers,
        };
      },
    } as DecisionPort;
    const reviewer = fakeReviewer();

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer },
      config: makeConfig(),
    });

    expect(result.failedClosed).toBe(true);
    expect(result.triage).not.toBeNull();
    expect(result.hunkProfile).toBeNull();
    expect(result.publication.check.conclusion).toBe("failure");
    expect(result.publication.summaryMarkdown).toContain("hunk-profile");
  });

  it("is idempotent: re-running over the same PR produces identical fingerprints (NFR-12)", async () => {
    const pr = makePr();
    const decision = scriptedPort({
      ...HIGH_RISK_TRIAGE_SCRIPT,
      risk: {
        type: "score",
        score: 2,
        confidence: 0.95,
        legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
        probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.05, 4: 0.02 },
      },
      change_kind: {
        type: "choice",
        choice: "modify-behavior",
        confidence: 0.9,
        probabilities: { "modify-behavior": 0.9 },
      },
      touches_error_handling: { type: "noul", noul: 0.1 },
      touches_async: { type: "noul", noul: 0.1 },
      "a.ts#0-f0__is_real_defect": { type: "noul", noul: 0.99 },
      "a.ts#0-f0__severity": {
        type: "score",
        score: 2,
        confidence: 0.8,
        legend: { 0: "nit", 1: "minor", 2: "major", 3: "critical" },
        probabilities: { 0: 0.1, 1: 0.1, 2: 0.7, 3: 0.1 },
      },
      "a.ts#0-f0__is_style_only": { type: "noul", noul: 0.05 },
      "a.ts#0-f0__actionable": { type: "noul", noul: 0.9 },
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });
    const reviewer = fakeReviewer([
      {
        lineStart: 1,
        lineEnd: 1,
        claim: "off-by-one",
        rationale: "uses <= instead of <",
        suggestedSeverity: "major",
      },
    ]);
    const config = makeConfig();

    const first = await runPipeline({
      ref,
      ports: { vcs: makeVcs(pr), decision, reviewer },
      config,
    });
    const second = await runPipeline({
      ref,
      ports: { vcs: makeVcs(pr), decision, reviewer },
      config,
    });

    expect(second.publication.summaryFingerprint).toBe(first.publication.summaryFingerprint);
    expect(second.publication.inlineComments[0]!.fingerprint).toBe(
      first.publication.inlineComments[0]!.fingerprint,
    );
  });
});
