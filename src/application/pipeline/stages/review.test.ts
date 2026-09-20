import { describe, expect, it } from "vitest";
import type {
  ReviewInput,
  ReviewOutput,
  ReviewerPort,
} from "../../../domain/ports/reviewer-port.js";
import type { ModelPricing } from "../../findings/pricing.js";
import type { HunkProfileEntry } from "./hunk-profile.js";
import { runReviewStage } from "./review.js";

const pricing: ModelPricing = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
};

function makeHunk(overrides: Partial<HunkProfileEntry> = {}): HunkProfileEntry {
  return {
    id: "a.ts#0",
    file: "a.ts",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "old",
    diff: "@@ -1,1 +1,1 @@\n-old\n+new",
    oldStart: 1,
    newStart: 1,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.9,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
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

function makeReviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    findings: [],
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 500,
    requestId: "rev1",
    ...overrides,
  };
}

function fakeReviewer(impl: (input: ReviewInput) => Promise<ReviewOutput>): ReviewerPort {
  return { review: impl };
}

describe("runReviewStage", () => {
  it("reviews each eligible hunk, passing its profile to ReviewInput.profile", async () => {
    const hunk = makeHunk();
    let capturedInput: ReviewInput | undefined;
    const reviewer = fakeReviewer(async (input) => {
      capturedInput = input;
      return makeReviewOutput();
    });

    const result = await runReviewStage({
      hunks: [hunk],
      reviewerPort: reviewer,
      pricing,
      budgetUsd: 10,
    });

    expect(result.reviews).toHaveLength(1);
    expect(capturedInput!.hunkId).toBe("a.ts#0");
    expect(capturedInput!.file).toBe("a.ts");
    expect(capturedInput!.language).toBe("typescript");
    expect(capturedInput!.before).toBe("old");
    expect(capturedInput!.diff).toBe(hunk.diff);
    expect(capturedInput!.profile).toEqual({
      changeKind: "modify-behavior",
      touchesErrorHandling: 0.1,
      touchesAsync: 0.1,
      touchesPublicApi: false,
      touchesPublicApiPartial: true,
      astSkipped: null,
    });
  });

  it("detects PHP from a .php file path instead of falling back to a hardcoded/generic language", async () => {
    const hunk = makeHunk({ id: "a.php#0", file: "app/Http/Controllers/UserController.php" });
    let capturedInput: ReviewInput | undefined;
    const reviewer = fakeReviewer(async (input) => {
      capturedInput = input;
      return makeReviewOutput();
    });
    await runReviewStage({ hunks: [hunk], reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(capturedInput!.language).toBe("php");
  });

  it("detects Vue from a .vue file path", async () => {
    const hunk = makeHunk({ id: "a.vue#0", file: "src/components/Widget.vue" });
    let capturedInput: ReviewInput | undefined;
    const reviewer = fakeReviewer(async (input) => {
      capturedInput = input;
      return makeReviewOutput();
    });
    await runReviewStage({ hunks: [hunk], reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(capturedInput!.language).toBe("vue");
  });

  it("detects Blade from a .blade.php file path, distinct from plain PHP", async () => {
    const hunk = makeHunk({ id: "a.blade#0", file: "resources/views/welcome.blade.php" });
    let capturedInput: ReviewInput | undefined;
    const reviewer = fakeReviewer(async (input) => {
      capturedInput = input;
      return makeReviewOutput();
    });
    await runReviewStage({ hunks: [hunk], reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(capturedInput!.language).toBe("blade");
  });

  it("skips hunks marked skippedFromReview or containsSecret", async () => {
    const hunks = [
      makeHunk({ id: "a#0", skippedFromReview: true }),
      makeHunk({ id: "b#0", containsSecret: true }),
      makeHunk({ id: "c#0" }),
    ];
    let callCount = 0;
    const reviewer = fakeReviewer(async () => {
      callCount++;
      return makeReviewOutput();
    });

    const result = await runReviewStage({ hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(callCount).toBe(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]!.hunkId).toBe("c#0");
  });

  it("continues past a per-hunk reviewer error, recording it", async () => {
    const hunks = [makeHunk({ id: "ok#0" }), makeHunk({ id: "bad#0" })];
    const reviewer = fakeReviewer(async (input) => {
      if (input.hunkId === "bad#0") throw new Error("provider exploded");
      return makeReviewOutput();
    });

    const result = await runReviewStage({ hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(result.reviews).toHaveLength(2);
    const bad = result.reviews.find((r) => r.hunkId === "bad#0")!;
    expect(bad.error).toMatch(/provider exploded/);
    expect(bad.findings).toEqual([]);
    const ok = result.reviews.find((r) => r.hunkId === "ok#0")!;
    expect(ok.error).toBeNull();
  });

  it("stops calling the reviewer once the budget is exceeded, counting the rest as skipped (FR-4.3)", async () => {
    const hunks = [makeHunk({ id: "a#0" }), makeHunk({ id: "b#0" }), makeHunk({ id: "c#0" })];
    let callCount = 0;
    // Each call costs (1000/1e6)*2 + (200/1e6)*10 = 0.002 + 0.002 = 0.004 usd.
    const reviewer = fakeReviewer(async () => {
      callCount++;
      return makeReviewOutput();
    });

    const result = await runReviewStage({
      hunks,
      reviewerPort: reviewer,
      pricing,
      // Budget is checked AFTER each call completes (a call's real cost is
      // only known once it returns usage) — set to exactly one call's
      // cost so the 1st call reaches the cap and the 2nd never starts.
      budgetUsd: 0.004,
    });

    expect(callCount).toBe(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.budgetExceeded).toBe(true);
    expect(result.skippedForBudgetCount).toBe(2);
  });

  it("accumulates total cost across reviews", async () => {
    const hunks = [makeHunk({ id: "a#0" }), makeHunk({ id: "b#0" })];
    const reviewer = fakeReviewer(async () => makeReviewOutput());
    const result = await runReviewStage({ hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(result.totalCostUsd).toBeCloseTo(0.008, 10); // 2 * 0.004
  });

  it("returns no reviews and zero cost when there are no eligible hunks", async () => {
    const hunks = [makeHunk({ skippedFromReview: true })];
    const reviewer = fakeReviewer(async () => makeReviewOutput());
    const result = await runReviewStage({ hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(result.reviews).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.budgetExceeded).toBe(false);
  });
});
