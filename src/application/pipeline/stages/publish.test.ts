import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReviewPublication } from "../../../domain/ports/vcs-port.js";
import type { SpendCapEvaluation } from "../../../domain/spend-cap.js";
import type { FilteredFinding, FindingFilterStageResult } from "./finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";
import type { MergeGateStageResult } from "./merge-gate.js";
import {
  type PublishStageInput,
  buildFailClosedPublication,
  runPublishStage,
  runTriageOnlyPublishStage,
} from "./publish.js";
import type { ReviewStageResult } from "./review.js";
import type { TriageStageResult } from "./triage.js";

function makeTriage(overrides: Partial<TriageStageResult> = {}): TriageStageResult {
  return {
    category: "bugfix",
    categoryConfidence: 0.9,
    riskLevel: "low",
    riskScore: 1,
    riskConfidence: 0.9,
    needsHumanProb: 0.1,
    containsInjectedInstructionsProb: 0.05,
    size: "small",
    skipLlmReview: false,
    needsHumanLabel: false,
    requestId: "triage1",
    latencyMs: 10,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...overrides,
  };
}

function makeHunkEntry(overrides: Partial<HunkProfileEntry> = {}): HunkProfileEntry {
  return {
    id: "a.ts#0",
    file: "a.ts",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "old",
    diff: "@@ -1,1 +1,1 @@\n-old\n+new",
    oldStart: 1,
    newStart: 1,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.95,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
    touchesPublicApi: false,
    touchesPublicApiPartial: false,
    requestId: "hp1",
    latencyMs: 5,
    usage: { inputTokens: 10, outputTokens: 2 },
    skippedFromReview: false,
    containsSecret: false,
    profileFailed: false,
    astSkipped: null,
    ...overrides,
  };
}

function makeHunkProfile(hunks: HunkProfileEntry[]): HunkProfileStageResult {
  return {
    hunks,
    truncatedHunkCount: 0,
    totalRequests: hunks.length,
    totalLatencyMs: 5 * hunks.length,
    totalUsage: { inputTokens: 10 * hunks.length, outputTokens: 2 * hunks.length },
  };
}

function makeReview(overrides: Partial<ReviewStageResult> = {}): ReviewStageResult {
  return {
    reviews: [],
    totalCostUsd: 0.01,
    budgetExceeded: false,
    skippedForBudgetCount: 0,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FilteredFinding> = {}): FilteredFinding {
  return {
    findingId: "a.ts#0-f0",
    hunkId: "a.ts#0",
    file: "a.ts",
    lineStart: 10,
    lineEnd: 12,
    claim: "off-by-one",
    rationale: "uses <= instead of <",
    isRealDefectProb: 0.95,
    jevSeverityScore: 2,
    isStyleOnlyProb: 0.05,
    actionableProb: 0.9,
    requestId: "ff1",
    unverified: false,
    ...overrides,
  };
}

function makeFindingFilter(
  overrides: Partial<FindingFilterStageResult> = {},
): FindingFilterStageResult {
  return {
    published: [],
    needsHuman: [],
    discarded: [],
    totalRequests: 0,
    totalLatencyMs: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function makeMergeGate(overrides: Partial<MergeGateStageResult> = {}): MergeGateStageResult {
  return {
    safeToAutomergeProb: 0.95,
    conclusion: "success",
    requestId: "mg1",
    latencyMs: 5,
    usage: { inputTokens: 5, outputTokens: 1 },
    ...overrides,
  };
}

describe("runPublishStage", () => {
  it("creates one inline comment per published (auto-band) finding, with a stable fingerprint", () => {
    const finding = makeFinding();
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [finding] }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });

    expect(result.inlineComments).toHaveLength(1);
    const comment = result.inlineComments[0]!;
    expect(comment.path).toBe("a.ts");
    expect(comment.body).toContain("off-by-one");
    expect(comment.body).toContain("uses <= instead of <");
    const expectedFingerprint = createHash("sha256")
      .update(`${comment.path}:${comment.line}:${finding.claim}`)
      .digest("hex");
    expect(comment.fingerprint).toBe(expectedFingerprint);
  });

  it("maps the finding's before-side lineStart to the hunk's after-side (HEAD) line for the comment (FR-4.1 vs VcsPort contract)", () => {
    // ReviewFindingCandidate.lineStart/lineEnd are BEFORE-side lines, but
    // InlineComment.line must be a HEAD-side line — an inserted line ahead
    // of the finding's line should shift it forward.
    const hunk = makeHunkEntry({
      id: "shift.ts#0",
      file: "shift.ts",
      oldStart: 10,
      newStart: 10,
      diff: ["@@ -10,2 +10,3 @@", " a", "+inserted", " b"].join("\n"),
    });
    const finding = makeFinding({
      hunkId: "shift.ts#0",
      file: "shift.ts",
      lineStart: 11,
      lineEnd: 11,
    });
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([hunk]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [finding] }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    // before-line 11 ("b") is shifted to after-line 12 by the inserted line.
    expect(result.inlineComments[0]!.line).toBe(12);
  });

  it("does not create inline comments for needsHuman or discarded findings", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter({
        needsHuman: [makeFinding({ findingId: "b" })],
        discarded: [makeFinding({ findingId: "c" })],
      }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(result.inlineComments).toHaveLength(0);
  });

  it("includes the triage decision, skipped hunks with reason, needs-human findings and discarded count in the summary", () => {
    const skippedHunk = makeHunkEntry({
      id: "b.ts#0",
      file: "b.ts",
      skippedFromReview: true,
      changeKind: "rename-or-format",
      changeKindConfidence: 0.97,
    });
    const secretHunk = makeHunkEntry({
      id: "c.ts#0",
      file: "c.ts",
      skippedFromReview: true,
      containsSecret: true,
      changeKind: null,
      changeKindConfidence: null,
    });
    const result = runPublishStage({
      triage: makeTriage({ category: "security", riskLevel: "high" }),
      hunkProfile: makeHunkProfile([makeHunkEntry(), skippedHunk, secretHunk]),
      review: makeReview(),
      findingFilter: makeFindingFilter({
        needsHuman: [makeFinding({ claim: "possible race condition" })],
        discarded: [makeFinding({ findingId: "x" }), makeFinding({ findingId: "y" })],
      }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });

    expect(result.summaryMarkdown).toContain("security");
    expect(result.summaryMarkdown).toContain("high");
    expect(result.summaryMarkdown).toContain("b.ts");
    expect(result.summaryMarkdown).toContain("rename-or-format");
    expect(result.summaryMarkdown).toContain("0.97");
    expect(result.summaryMarkdown).toContain("c.ts");
    expect(result.summaryMarkdown).toContain("secret");
    expect(result.summaryMarkdown).toContain("possible race condition");
    expect(result.summaryMarkdown).toMatch(/discarded.*2/i);
  });

  it("flags an unverified (Jev-failed) needs-human finding distinctly in the summary (NFR-2)", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter({
        needsHuman: [makeFinding({ claim: "unverifiable claim", unverified: true })],
      }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(result.summaryMarkdown).toMatch(/unverifiable claim.*unverified/i);
  });

  it("includes a cost breakdown (LLM usd cost and Jev token usage) in the summary", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview({ totalCostUsd: 0.1234 }),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(result.summaryMarkdown).toContain("0.1234");
    expect(result.summaryMarkdown.toLowerCase()).toContain("jev");
  });

  it("sets the check conclusion and title/summary from the merge gate result", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate({ conclusion: "failure" }),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(result.check.conclusion).toBe("failure");
    expect(result.check.title.length).toBeGreaterThan(0);
    expect(result.check.summary.length).toBeGreaterThan(0);
  });

  it("adds the auto-merge-ok label only when the merge gate succeeds, and removes it otherwise", () => {
    const success = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate({ conclusion: "success" }),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(success.labelsToAdd).toContain("jevest:auto-merge-ok");
    expect(success.labelsToRemove).not.toContain("jevest:auto-merge-ok");

    const failure = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate({ conclusion: "failure" }),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(failure.labelsToAdd).not.toContain("jevest:auto-merge-ok");
    expect(failure.labelsToRemove).toContain("jevest:auto-merge-ok");
  });

  it("adds the needs-human label when triage flagged it", () => {
    const result = runPublishStage({
      triage: makeTriage({ needsHumanLabel: true }),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    expect(result.labelsToAdd).toContain("jevest:needs-human");
  });

  it("publishes no inline comments when inlineCommentsEnabled is false, listing auto-band findings in the summary instead", () => {
    const finding = makeFinding({ claim: "off-by-one", file: "a.ts", lineStart: 10 });
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [finding] }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: false,
      reviewDisabled: false,
    });

    expect(result.inlineComments).toEqual([]);
    expect(result.summaryMarkdown).toContain("Findings (high confidence)");
    expect(result.summaryMarkdown).toContain("off-by-one");
    expect(result.summaryMarkdown).toContain("a.ts");
  });

  it("leaves the check status and labels unchanged when inlineCommentsEnabled is false", () => {
    const withInline = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [makeFinding()] }),
      mergeGate: makeMergeGate({ conclusion: "success" }),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    });
    const withoutInline = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [makeFinding()] }),
      mergeGate: makeMergeGate({ conclusion: "success" }),
      inlineCommentsEnabled: false,
      reviewDisabled: false,
    });
    expect(withoutInline.check).toEqual(withInline.check);
    expect(withoutInline.labelsToAdd).toEqual(withInline.labelsToAdd);
    expect(withoutInline.labelsToRemove).toEqual(withInline.labelsToRemove);
  });

  it("shows 'no high-confidence findings' when inlineCommentsEnabled is false and nothing was published", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: false,
      reviewDisabled: false,
    });
    expect(result.summaryMarkdown).toMatch(/no.*high.confidence findings/i);
  });

  it("is idempotent: identical input produces identical fingerprints on re-run (NFR-12)", () => {
    const input = {
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview(),
      findingFilter: makeFindingFilter({ published: [makeFinding()] }),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
    };
    const first = runPublishStage(input);
    const second = runPublishStage(input);
    expect(second.summaryFingerprint).toBe(first.summaryFingerprint);
    expect(second.inlineComments[0]!.fingerprint).toBe(first.inlineComments[0]!.fingerprint);
  });

  it("notes 'LLM review disabled by config' in the summary when reviewDisabled is true (Jev-only mode)", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview({ reviews: [], totalCostUsd: 0 }),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: true,
    });
    expect(result.summaryMarkdown).toContain("LLM review disabled by config");
    expect(result.inlineComments).toEqual([]);
  });

  it("still runs the merge gate normally (triage + CI status) when reviewDisabled is true", () => {
    const result = runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([]),
      review: makeReview({ reviews: [], totalCostUsd: 0 }),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate({ conclusion: "success" }),
      inlineCommentsEnabled: true,
      reviewDisabled: true,
    });
    expect(result.check.conclusion).toBe("success");
  });
});

describe("runPublishStage spend cap", () => {
  function evaluation(overrides: Partial<SpendCapEvaluation> = {}): SpendCapEvaluation {
    return {
      status: "ok",
      period: "month",
      periodKey: "2026-09",
      spentUsd: 12.3456,
      capUsd: 50,
      warnAtUsd: 40,
      remainingUsd: 37.6544,
      effectiveBudgetUsd: 5,
      ...overrides,
    };
  }

  function publish(extra: Partial<PublishStageInput>): ReviewPublication {
    return runPublishStage({
      triage: makeTriage(),
      hunkProfile: makeHunkProfile([makeHunkEntry()]),
      review: makeReview(),
      findingFilter: makeFindingFilter(),
      mergeGate: makeMergeGate(),
      inlineCommentsEnabled: true,
      reviewDisabled: false,
      ...extra,
    });
  }

  it("omits the section and touches no spend labels when no spend cap info is given", () => {
    const result = publish({});
    expect(result.summaryMarkdown).not.toContain("Spend cap");
    expect(result.labelsToAdd).not.toContain("jevest:spend-warning");
    expect(result.labelsToRemove).not.toContain("jevest:spend-warning");
  });

  it("renders spent/cap/period/remaining and clears both spend labels when ok", () => {
    const result = publish({ spendCap: evaluation() });
    expect(result.summaryMarkdown).toContain("### Spend cap");
    expect(result.summaryMarkdown).toContain("USD 12.35 of 50.00 this month (37.65 left)");
    expect(result.summaryMarkdown).toContain("Status: ok");
    expect(result.labelsToRemove).toEqual(
      expect.arrayContaining(["jevest:spend-warning", "jevest:spend-cap-reached"]),
    );
    expect(result.check.summary).not.toContain("Spend cap");
  });

  it("adds the warning label and a check-summary line when warning", () => {
    const result = publish({
      spendCap: evaluation({ status: "warning", spentUsd: 42, remainingUsd: 8 }),
    });
    expect(result.labelsToAdd).toContain("jevest:spend-warning");
    expect(result.labelsToRemove).toContain("jevest:spend-cap-reached");
    expect(result.check.summary).toContain("Spend cap warning: USD 42.00 of 50.00 (2026-09)");
  });

  it("puts 'LLM review skipped: spend cap reached' at the top and adds the reached label", () => {
    const result = publish({
      spendCap: evaluation({ status: "reached", spentUsd: 50.5, remainingUsd: 0 }),
      reviewSkippedForSpendCap: true,
    });
    const lines = result.summaryMarkdown.split("\n");
    expect(lines[2]).toContain("**LLM review skipped: spend cap reached**");
    expect(result.labelsToAdd).toContain("jevest:spend-cap-reached");
    expect(result.labelsToRemove).toContain("jevest:spend-warning");
    expect(result.check.summary).toContain("Spend cap reached: USD 50.50 of 50.00 (2026-09)");
  });

  it("notes an unavailable ledger in the summary without touching labels", () => {
    const result = publish({ spendCap: null, spendLedgerError: "boom 500" });
    expect(result.summaryMarkdown).toContain("spend ledger unavailable: boom 500");
    expect(result.labelsToAdd).not.toContain("jevest:spend-warning");
    expect(result.labelsToRemove).not.toContain("jevest:spend-warning");
  });

  it('uses "in total" wording for the total period', () => {
    const result = publish({ spendCap: evaluation({ period: "total", periodKey: "total" }) });
    expect(result.summaryMarkdown).toContain("USD 12.35 of 50.00 in total (37.65 left)");
  });
});

describe("runTriageOnlyPublishStage", () => {
  it("publishes only the triage decision and label, no findings or comments (FR-2.3)", () => {
    const triage = makeTriage({ category: "docs", riskLevel: "none", needsHumanLabel: false });
    const result = runTriageOnlyPublishStage(triage);

    expect(result.inlineComments).toEqual([]);
    expect(result.summaryMarkdown).toContain("docs");
    expect(result.summaryMarkdown).toContain("none");
    expect(result.summaryMarkdown.toLowerCase()).toContain("skipped");
    expect(result.check.conclusion).toBe("success");
    expect(result.labelsToAdd).not.toContain("jevest:auto-merge-ok");
    expect(result.labelsToRemove).toContain("jevest:auto-merge-ok");
  });

  it("still adds the needs-human label when triage flagged it, even though the LLM review was skipped", () => {
    const triage = makeTriage({ needsHumanLabel: true });
    const result = runTriageOnlyPublishStage(triage);
    expect(result.labelsToAdd).toContain("jevest:needs-human");
  });
});

describe("buildFailClosedPublication", () => {
  it("fails closed with no inline comments, needs-human label, and a failure check (NFR-2)", () => {
    const result = buildFailClosedPublication("hunk-profile", null);
    expect(result.inlineComments).toEqual([]);
    expect(result.check.conclusion).toBe("failure");
    expect(result.labelsToAdd).toContain("jevest:needs-human");
    expect(result.labelsToRemove).toContain("jevest:auto-merge-ok");
    expect(result.summaryMarkdown).toContain("hunk-profile");
  });

  it("includes the last known triage decision in the summary when available", () => {
    const triage = makeTriage({ category: "security", riskLevel: "high" });
    const result = buildFailClosedPublication("finding-filter", triage);
    expect(result.summaryMarkdown).toContain("security");
    expect(result.summaryMarkdown).toContain("high");
  });
});
