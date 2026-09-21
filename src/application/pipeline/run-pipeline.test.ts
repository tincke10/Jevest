import { describe, expect, it } from "vitest";
import type { JevestConfig } from "../../adapters/config/jevest-config.js";
import { createFakeSpendLedger } from "../../adapters/spend-ledger/fake-spend-ledger.js";
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
    publish: { inlineComments: true },
    budgetUsd: 5,
    spendCap: { usd: 50, period: "month", warnAtUsd: 40 },
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

  it("skips the review stage entirely, empties findings/inline comments, but still runs the merge gate when reviewer.provider is 'none' (Jev-only mode)", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
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
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });
    let reviewerCalled = false;
    const trackedReviewer: ReviewerPort = {
      review: async (input) => {
        reviewerCalled = true;
        return fakeReviewer().review(input);
      },
    };

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer: trackedReviewer },
      config: makeConfig({ reviewer: { provider: "none", model: undefined } }),
    });

    expect(reviewerCalled).toBe(false);
    expect(result.failedClosed).toBe(false);
    expect(result.review).toEqual({
      reviews: [],
      totalCostUsd: 0,
      budgetExceeded: false,
      skippedForBudgetCount: 0,
    });
    expect(result.findingFilter!.published).toEqual([]);
    expect(result.publication.inlineComments).toEqual([]);
    expect(result.publication.summaryMarkdown).toContain("LLM review disabled by config");
    // Merge gate still ran normally on triage + CI status: safe=0.95 at
    // medium-risk thresholds (autoMin=0.97, confirmMin=0.8) bands as
    // "neutral" here, not "failure" — proving it genuinely evaluated
    // rather than being forced to fail-closed by the disabled reviewer.
    expect(result.mergeGate).not.toBeNull();
    expect(result.mergeGate!.safeToAutomergeProb).toBe(0.95);
    expect(result.publication.check.conclusion).toBe("neutral");
  });

  it("does not require a reviewer port at all when reviewer.provider is 'none'", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
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
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision },
      config: makeConfig({ reviewer: { provider: "none", model: undefined } }),
    });

    expect(result.failedClosed).toBe(false);
  });

  it("publishes no inline comments and lists auto-band findings in the summary when publish.inlineComments is false", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
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

    const result = await runPipeline({
      ref,
      ports: { vcs, decision, reviewer },
      config: makeConfig({ publish: { inlineComments: false } }),
    });

    expect(result.publication.inlineComments).toEqual([]);
    expect(result.publication.summaryMarkdown).toContain("Findings (high confidence)");
    expect(result.publication.summaryMarkdown).toContain("off-by-one");
  });
});

describe("runPipeline spend cap (NFR-10 cumulative)", () => {
  const NOW = new Date("2026-09-21T16:00:00.000Z");

  /** Medium risk so the full pipeline runs; no findings so the filter has nothing to ask. */
  function fullRunPort(): DecisionPort {
    return scriptedPort({
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
      safe_to_automerge: { type: "noul", noul: 0.95 },
    });
  }

  function trackedReviewer(): ReviewerPort & { calls: number } {
    const tracked = {
      calls: 0,
      async review(input: Parameters<ReviewerPort["review"]>[0]) {
        tracked.calls += 1;
        return fakeReviewer().review(input);
      },
    };
    return tracked;
  }

  it("reads the ledger, runs the review and records llm + jev spend for the PR", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const reviewer = trackedReviewer();
    const spendLedger = createFakeSpendLedger();

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer, spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(reviewer.calls).toBe(1);
    expect(result.reviewSkippedForSpendCap).toBe(false);
    expect(result.spendLedgerError).toBeNull();
    expect(spendLedger.entries).toHaveLength(1);
    const entry = spendLedger.entries[0]!;
    expect(entry.periodKey).toBe("2026-09");
    expect(entry.prNumber).toBe(1);
    expect(entry.headSha).toBe("head");
    expect(entry.llmUsd).toBe(result.review!.totalCostUsd);
    expect(entry.llmUsd).toBeGreaterThan(0);
    // triage (1 input token) + hunk-profile (1 input token) at $0.042/MTok.
    expect(entry.jevUsd).toBeCloseTo((2 * 0.042) / 1e6, 12);
    expect(entry.at).toBe(NOW.toISOString());
    // The evaluation reported is the post-run one (cumulative after this run).
    expect(result.spendCap).toMatchObject({
      status: "ok",
      periodKey: "2026-09",
      spentUsd: spendLedger.current()!.spentUsd,
      capUsd: 50,
    });
    expect(result.publication.summaryMarkdown).toContain("### Spend cap");
    expect(result.publication.labelsToRemove).toContain("jevest:spend-warning");
  });

  it("skips the LLM review (Jev-only run) when the cap is already reached, still records the run", async () => {
    const pr = makePr();
    const vcs = makeVcs(pr);
    const reviewer = trackedReviewer();
    const spendLedger = createFakeSpendLedger({
      seed: { periodKey: "2026-09", spentUsd: 50, runs: 10, updatedAt: "2026-09-20T00:00:00Z" },
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer, spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(reviewer.calls).toBe(0);
    expect(result.reviewSkippedForSpendCap).toBe(true);
    expect(result.review).toEqual({
      reviews: [],
      totalCostUsd: 0,
      budgetExceeded: false,
      skippedForBudgetCount: 0,
    });
    expect(result.mergeGate).not.toBeNull();
    expect(result.spendCap?.status).toBe("reached");
    expect(spendLedger.entries[0]?.llmUsd).toBe(0);
    expect(spendLedger.current()?.runs).toBe(11);
    expect(result.publication.summaryMarkdown).toContain("LLM review skipped: spend cap reached");
    expect(result.publication.labelsToAdd).toContain("jevest:spend-cap-reached");
    expect(result.publication.summaryMarkdown).not.toContain("LLM review disabled by config");
  });

  it("passes the clamped effective budget to the review stage when little is left under the cap", async () => {
    const pr = makePr({
      files: [
        {
          path: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
        {
          path: "b.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });
    const vcs = makeVcs(pr);
    const reviewer = trackedReviewer();
    // 49.9999 spent: 0.0001 left, which one fake review (100 in / 20 out at Sonnet 5 rates = $0.0004) exceeds.
    const spendLedger = createFakeSpendLedger({
      seed: {
        periodKey: "2026-09",
        spentUsd: 49.9999,
        runs: 10,
        updatedAt: "2026-09-20T00:00:00Z",
      },
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer, spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(result.reviewSkippedForSpendCap).toBe(false);
    expect(reviewer.calls).toBe(1);
    expect(result.review?.budgetExceeded).toBe(true);
    expect(result.review?.skippedForBudgetCount).toBe(1);
    expect(result.spendCap?.status).toBe("reached");
  });

  it("treats a ledger from a previous month as zero and starts a fresh total", async () => {
    const vcs = makeVcs(makePr());
    const reviewer = trackedReviewer();
    const spendLedger = createFakeSpendLedger({
      seed: { periodKey: "2026-08", spentUsd: 50, runs: 10, updatedAt: "2026-08-31T00:00:00Z" },
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer, spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(reviewer.calls).toBe(1);
    expect(result.reviewSkippedForSpendCap).toBe(false);
    expect(spendLedger.current()).toMatchObject({ periodKey: "2026-09", runs: 1 });
  });

  it("carries a warning status and label once spend passes warnAtUsd", async () => {
    const vcs = makeVcs(makePr());
    const spendLedger = createFakeSpendLedger({
      seed: { periodKey: "2026-09", spentUsd: 41, runs: 10, updatedAt: "2026-09-20T00:00:00Z" },
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer: trackedReviewer(), spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(result.reviewSkippedForSpendCap).toBe(false);
    expect(result.spendCap?.status).toBe("warning");
    expect(result.publication.labelsToAdd).toContain("jevest:spend-warning");
    expect(result.publication.check.summary).toContain("Spend cap warning");
  });

  it("does not fail the run when the ledger cannot be read: runs the review on the full budget and notes it", async () => {
    const vcs = makeVcs(makePr());
    const reviewer = trackedReviewer();
    const spendLedger = createFakeSpendLedger({ readError: new Error("issues API 500") });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer, spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(result.failedClosed).toBe(false);
    expect(reviewer.calls).toBe(1);
    expect(result.reviewSkippedForSpendCap).toBe(false);
    // The fake only fails `read`; `record` still went through, so the
    // post-run evaluation is known and reported alongside the read error.
    expect(result.spendCap).toMatchObject({ status: "ok", periodKey: "2026-09" });
    expect(result.spendLedgerError).toContain("issues API 500");
    expect(result.publication.summaryMarkdown).toContain(
      "spend ledger unavailable: issues API 500",
    );
  });

  it("does not fail the run when recording fails: keeps the pre-run evaluation and notes the error", async () => {
    const vcs = makeVcs(makePr());
    const spendLedger = createFakeSpendLedger({
      seed: { periodKey: "2026-09", spentUsd: 10, runs: 2, updatedAt: "2026-09-20T00:00:00Z" },
      recordError: new Error("update 502"),
    });

    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer: trackedReviewer(), spendLedger },
      config: makeConfig(),
      now: () => NOW,
    });

    expect(result.failedClosed).toBe(false);
    expect(result.spendCap).toMatchObject({ status: "ok", spentUsd: 10 });
    expect(result.spendLedgerError).toContain("update 502");
  });

  it("leaves spendCap null and never touches the ledger when no port is wired", async () => {
    const vcs = makeVcs(makePr());
    const result = await runPipeline({
      ref,
      ports: { vcs, decision: fullRunPort(), reviewer: trackedReviewer() },
      config: makeConfig(),
    });
    expect(result.spendCap).toBeNull();
    expect(result.spendLedgerError).toBeNull();
    expect(result.reviewSkippedForSpendCap).toBe(false);
    expect(result.publication.summaryMarkdown).not.toContain("Spend cap");
  });

  it("does not record anything on a triage-only run (FR-2.3), which spends nothing on the LLM", async () => {
    const vcs = makeVcs(makePr());
    const spendLedger = createFakeSpendLedger();
    const result = await runPipeline({
      ref,
      ports: { vcs, decision: scriptedPort(HIGH_RISK_TRIAGE_SCRIPT), spendLedger },
      config: makeConfig(),
    });
    expect(result.review).toBeNull();
    expect(spendLedger.entries).toEqual([]);
    expect(result.spendCap).toBeNull();
  });
});
