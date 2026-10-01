import { describe, expect, it } from "vitest";
import { createFakeAgenticReviewer } from "../../../adapters/agentic/fake-agentic.js";
import type { AgenticFinding } from "../../../domain/agentic-finding.js";
import { EMPTY_AUTHOR_CONTEXT } from "../../../domain/author-context.js";
import type { PullRequestData, PullRequestFile } from "../../../domain/pull-request.js";
import {
  AGENTIC_UNAVAILABLE_PREFIX,
  buildAgenticDiff,
  runAgenticReviewStage,
} from "./agentic-review.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function file(path: string, patch: string): PullRequestFile {
  return { path, status: "modified", additions: 1, deletions: 1, patch };
}

function makePr(
  files: PullRequestFile[] = [file("src/a.ts", "@@ -1 +1 @@\n-old\n+new")],
): PullRequestData {
  return {
    ref: { owner: "acme", repo: "widgets", number: 7, headSha: "h", baseSha: "b" },
    title: `Fix totals ${SECRET}`,
    body: "Rounds per line.",
    author: "dev",
    labels: [],
    baseBranch: "main",
    files,
    ciStatus: "success",
  };
}

function makeHunk(id: string, overrides: Partial<HunkProfileEntry> = {}): HunkProfileEntry {
  return {
    id,
    file: "src/a.ts",
    hunkHeader: "@@ -1 +1 @@",
    before: "old",
    diff: "@@ -1 +1 @@\n-old\n+new",
    oldStart: 1,
    newStart: 1,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.9,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
    containsReviewerInstructionsProb: 0.03,
    touchesPublicApi: false,
    touchesPublicApiPartial: true,
    requestId: "req1",
    latencyMs: 10,
    usage: { inputTokens: 5, outputTokens: 0 },
    skippedFromReview: false,
    containsSecret: false,
    profileFailed: false,
    astSkipped: null,
    ...overrides,
  };
}

function profile(hunks: HunkProfileEntry[]): HunkProfileStageResult {
  return {
    hunks,
    injectedInstructionsInDiff: { maxProb: 0, hunkIds: [] },
    truncatedHunkCount: 0,
    totalRequests: hunks.length,
    totalLatencyMs: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
  } as HunkProfileStageResult;
}

const aFinding: AgenticFinding = {
  file: "src/a.ts",
  line: 1,
  category: "correctness",
  severity: "high",
  claim: "Wrong value.",
  failingScenario: "x -> y",
  evidence: [{ file: "src/a.ts", line: 1, quote: "new" }],
  confidence: 0.9,
};

describe("buildAgenticDiff", () => {
  it("joins every file's patch under a diff header, redacted per file (NFR-3)", () => {
    const { diff, note } = buildAgenticDiff(
      [
        file("src/a.ts", "@@ -1 +1 @@\n-a\n+b"),
        file("src/b.ts", `@@ -1 +1 @@\n+token = "${SECRET}"`),
      ],
      10_000,
    );
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(diff).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(diff).not.toContain(SECRET);
    expect(note).toBeUndefined();
  });

  it("leaves whole files out past the cap and says which", () => {
    const big = `@@ -1 +1 @@\n+${"x".repeat(500)}`;
    const { diff, note, omittedFiles } = buildAgenticDiff(
      [
        file("src/a.ts", "@@ -1 +1 @@\n+a"),
        file("src/big.ts", big),
        file("src/c.ts", "@@ -1 +1 @@\n+c"),
      ],
      200,
    );
    expect(diff).toContain("src/a.ts");
    expect(diff).not.toContain("src/big.ts");
    expect(diff).toContain("src/c.ts");
    expect(omittedFiles).toEqual(["src/big.ts"]);
    expect(note).toMatch(/1 file left out by the size cap.*src\/big\.ts.*Read/);
  });

  it("marks a file without a patch (binary, too large for the API) instead of dropping it silently", () => {
    const { diff } = buildAgenticDiff(
      [{ path: "img.png", status: "added", additions: 0, deletions: 0 }],
      1000,
    );
    expect(diff).toContain("diff --git a/img.png b/img.png\n(no textual diff");
  });
});

describe("runAgenticReviewStage", () => {
  const base = {
    pr: makePr(),
    hunkProfile: profile([makeHunk("h0"), makeHunk("h1")]),
    repoRoot: "/checkout",
    budgetUsd: 5,
  };

  it("runs the agent once in the checkout and returns its findings and numbers", async () => {
    const reviewer = createFakeAgenticReviewer([aFinding], {
      info: { nominalCostUsd: 0.7, turns: 11 },
    });
    const result = await runAgenticReviewStage({ ...base, reviewer });
    expect(reviewer.calls).toHaveLength(1);
    const call = reviewer.calls[0];
    expect(call?.repoRoot).toBe("/checkout");
    expect(call?.prId).toBe("acme/widgets#7");
    expect(call?.title).not.toContain(SECRET);
    expect(call?.changedFiles).toEqual(["src/a.ts"]);
    expect(call?.diff).toContain("+new");
    expect(result.status).toBe("ran");
    expect(result.findings).toEqual([aFinding]);
    expect(result.costUsd).toBe(0.7);
    expect(result.info?.turns).toBe(11);
  });

  it("books the run on the reviewable hunks so verdict, narrator and metrics keep working", async () => {
    const reviewer = createFakeAgenticReviewer([aFinding], { info: { nominalCostUsd: 0.7 } });
    const result = await runAgenticReviewStage({
      ...base,
      hunkProfile: profile([
        makeHunk("h0"),
        makeHunk("h1", { skippedFromReview: true }),
        makeHunk("h2"),
      ]),
      reviewer,
    });
    expect(result.review.reviews.map((r) => r.hunkId)).toEqual(["h0", "h2"]);
    expect(result.review.reviews.every((r) => r.error === null && r.findings.length === 0)).toBe(
      true,
    );
    expect(result.review.reviews[0]?.costUsd).toBe(0.7);
    expect(result.review.reviews[0]?.usage).not.toBeNull();
    expect(result.review.reviews[1]?.costUsd).toBe(0);
    expect(result.review.reviews[1]?.usage).toBeNull();
    expect(result.review.totalCostUsd).toBe(0.7);
  });

  it("passes the extracted author context and never the raw description with it", async () => {
    const reviewer = createFakeAgenticReviewer();
    const authorContext = { ...EMPTY_AUTHOR_CONTEXT, decisions: ["Round per line"] };
    await runAgenticReviewStage({ ...base, reviewer, authorContext, description: "raw" });
    expect(reviewer.calls[0]?.authorContext).toEqual(authorContext);
    expect(reviewer.calls[0]).not.toHaveProperty("description");
  });

  it("passes the redacted raw description when there is no extracted context", async () => {
    const reviewer = createFakeAgenticReviewer();
    await runAgenticReviewStage({ ...base, reviewer, description: `See ${SECRET}` });
    expect(reviewer.calls[0]?.description).toContain("See ");
    expect(reviewer.calls[0]?.description).not.toContain(SECRET);
  });

  it("fails closed to unavailable without a checkout: no agent call, every reviewable hunk marked failed with the note", async () => {
    const reviewer = createFakeAgenticReviewer([aFinding]);
    const result = await runAgenticReviewStage({
      ...base,
      repoRoot: undefined,
      unavailableReason: "no checkout",
      reviewer,
    });
    expect(reviewer.calls).toHaveLength(0);
    expect(result.status).toBe("unavailable");
    expect(result.findings).toEqual([]);
    expect(result.error).toBe(
      `${AGENTIC_UNAVAILABLE_PREFIX}: no checkout (agentic mode needs a checkout of the PR head)`,
    );
    expect(result.review.reviews).toHaveLength(2);
    expect(result.review.reviews.every((r) => r.error === result.error)).toBe(true);
  });

  it("records an agent failure on every reviewable hunk (the verdict becomes unavailable, never clear)", async () => {
    const reviewer = createFakeAgenticReviewer([], {
      error: new Error("the agent stopped before answering (error_max_turns, 40 turns)"),
    });
    const result = await runAgenticReviewStage({ ...base, reviewer });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/error_max_turns/);
    expect(result.review.reviews.every((r) => r.error !== null)).toBe(true);
  });

  it("does not run the agent when the per-run budget is already spent", async () => {
    const reviewer = createFakeAgenticReviewer();
    const result = await runAgenticReviewStage({ ...base, reviewer, budgetUsd: 0 });
    expect(reviewer.calls).toHaveLength(0);
    expect(result.status).toBe("skipped-budget");
    expect(result.review).toMatchObject({
      reviews: [],
      budgetExceeded: true,
      skippedForBudgetCount: 2,
    });
  });

  it("does not run the agent when no hunk is reviewable", async () => {
    const reviewer = createFakeAgenticReviewer();
    const result = await runAgenticReviewStage({
      ...base,
      hunkProfile: profile([makeHunk("h0", { skippedFromReview: true })]),
      reviewer,
    });
    expect(reviewer.calls).toHaveLength(0);
    expect(result.status).toBe("nothing-to-review");
    expect(result.review.reviews).toEqual([]);
  });
});
