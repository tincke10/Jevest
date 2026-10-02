import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import type {
  ReviewInput,
  ReviewOutput,
  ReviewerPort,
} from "../../../domain/ports/reviewer-port.js";
import type { ModelPricing } from "../../findings/pricing.js";
import { type HunkProfileEntry, runHunkProfileStage } from "./hunk-profile.js";
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

  it("skips hunks marked skippedFromReview, but reviews a hunk that contains a (redacted) secret", async () => {
    const hunks = [
      makeHunk({ id: "a#0", skippedFromReview: true }),
      makeHunk({ id: "b#0", containsSecret: true }),
      makeHunk({ id: "c#0" }),
    ];
    const reviewed: string[] = [];
    const reviewer = fakeReviewer(async (input) => {
      reviewed.push(input.hunkId);
      return makeReviewOutput();
    });

    const result = await runReviewStage({ hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });
    expect(reviewed).toEqual(["b#0", "c#0"]);
    expect(result.reviews.map((r) => r.hunkId)).toEqual(["b#0", "c#0"]);
  });

  it("NFR-3: the reviewer gets a secret hunk redacted, never the secret itself (hunk profile -> review)", async () => {
    const secret = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
    const password = `S3cr3t!${"Passw0rd"}`;
    const profile = await runHunkProfileStage({
      pr: {
        ref: { owner: "acme", repo: "widgets", number: 1, headSha: "head", baseSha: "base" },
        title: "t",
        body: "b",
        author: "dev",
        labels: [],
        baseBranch: "main",
        ciStatus: "success",
        files: [
          {
            path: "src/config.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
            patch: `@@ -1,1 +1,3 @@\n const region = "eu";\n+const apiKey = "${secret}";\n+DB_PASSWORD=${password}`,
          },
        ],
      },
      decisionPort: createFakeDecisionAdapter({
        contains_reviewer_instructions: { type: "noul", noul: 0.02 },
        change_kind: {
          type: "choice",
          choice: "add-behavior",
          confidence: 0.95,
          probabilities: { "add-behavior": 0.95, "modify-behavior": 0.05 },
        },
        touches_error_handling: { type: "noul", noul: 0.1 },
        touches_async: { type: "noul", noul: 0.1 },
      }),
      policyConfig: {
        hunkProfile: {
          low: { autoMin: 0.85, confirmMin: 0.55 },
          medium: { autoMin: 0.9, confirmMin: 0.6 },
        },
      },
      riskLevel: "medium",
      skipChangeKinds: ["rename-or-format"],
      maxHunks: 50,
    });
    const inputs: ReviewInput[] = [];
    const reviewer = fakeReviewer(async (input) => {
      inputs.push(input);
      return makeReviewOutput();
    });

    await runReviewStage({ hunks: profile.hunks, reviewerPort: reviewer, pricing, budgetUsd: 10 });

    expect(inputs).toHaveLength(1);
    const sent = JSON.stringify(inputs[0]);
    expect(sent).toContain("[REDACTED]");
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain(password);
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

  it("prefers the reviewer's nominalCostUsd over token pricing (subscription-billed claude-cli)", async () => {
    const hunk = makeHunk();
    const reviewer = fakeReviewer(async () =>
      makeReviewOutput({
        nominalCostUsd: 0.42,
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    );
    const result = await runReviewStage({
      hunks: [hunk],
      reviewerPort: reviewer,
      pricing,
      budgetUsd: 10,
    });
    expect(result.reviews[0]?.costUsd).toBe(0.42);
    expect(result.totalCostUsd).toBe(0.42);
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

describe("runReviewStage and the author's stated context", () => {
  const AUTHOR_CONTEXT = {
    decisions: ["cache of 5 minutes because the API allows 10 req/s"],
    intendedBehaviorChanges: [],
    outOfScope: [],
    constraints: [],
    references: [],
  };

  it("passes the same author context to every hunk", async () => {
    const inputs: ReviewInput[] = [];
    await runReviewStage({
      hunks: [makeHunk(), makeHunk({ id: "a.ts#1" })],
      reviewerPort: fakeReviewer(async (input) => {
        inputs.push(input);
        return makeReviewOutput();
      }),
      pricing,
      budgetUsd: 10,
      authorContext: AUTHOR_CONTEXT,
    });
    expect(inputs.map((i) => i.authorContext)).toEqual([AUTHOR_CONTEXT, AUTHOR_CONTEXT]);
  });

  it("leaves the key out entirely without one (the fixture key and prompt stay unchanged)", async () => {
    const inputs: ReviewInput[] = [];
    await runReviewStage({
      hunks: [makeHunk()],
      reviewerPort: fakeReviewer(async (input) => {
        inputs.push(input);
        return makeReviewOutput();
      }),
      pricing,
      budgetUsd: 10,
    });
    expect("authorContext" in inputs[0]!).toBe(false);
  });
});

describe("runReviewStage — code context and evidence", () => {
  const HUNK = makeHunk({
    id: "src/total.ts#0",
    file: "src/total.ts",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "return sum(items);",
    diff: "@@ -1,1 +1,1 @@\n-return sum(items);\n+return sumWithTax(items);",
  });
  const FULL_FILE = {
    path: "src/total.ts",
    mode: "full" as const,
    totalLines: 1,
    segments: [{ startLine: 1, lines: ["return sumWithTax(items);"] }],
    chars: 25,
  };
  const IMPACT = { symbols: ["sumWithTax"], snippets: [], chars: 0, truncated: false };
  const CONTEXT = {
    hunks: [
      {
        hunkId: "src/total.ts#0",
        file: "src/total.ts",
        fullFile: FULL_FILE,
        impactContext: IMPACT,
        symbols: ["sumWithTax"],
        matchesFound: 0,
        error: null,
      },
    ],
    unavailable: null,
    totals: { hunks: 1, files: 1, snippets: 0, fullFileChars: 25, impactChars: 0 },
  };

  function evidenceFinding(quote: string, file = "src/total.ts", line = 1) {
    return {
      lineStart: 1,
      lineEnd: 1,
      claim: "c",
      rationale: "r",
      suggestedSeverity: "major" as const,
      evidence: [{ file, line, quote }],
    };
  }

  it("adds no new keys to ReviewInput when every layer is off (fixture keys unchanged)", async () => {
    let captured: ReviewInput | undefined;
    await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async (input) => {
        captured = input;
        return makeReviewOutput();
      }),
      pricing,
      budgetUsd: 10,
    });
    expect(Object.keys(captured ?? {}).sort()).toEqual(
      ["before", "diff", "file", "hunkHeader", "hunkId", "language", "profile"].sort(),
    );
  });

  it("puts the hunk's full file and impact context on its ReviewInput, and asks for evidence", async () => {
    let captured: ReviewInput | undefined;
    await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async (input) => {
        captured = input;
        return makeReviewOutput();
      }),
      pricing,
      budgetUsd: 10,
      codeContext: CONTEXT,
      requireEvidence: true,
    });
    expect(captured?.fullFile).toEqual(FULL_FILE);
    expect(captured?.impactContext).toEqual(IMPACT);
    expect(captured?.requireEvidence).toBe(true);
  });

  it("leaves out a context layer that is null for the hunk", async () => {
    let captured: ReviewInput | undefined;
    await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async (input) => {
        captured = input;
        return makeReviewOutput();
      }),
      pricing,
      budgetUsd: 10,
      codeContext: {
        ...CONTEXT,
        hunks: [{ ...CONTEXT.hunks[0]!, fullFile: null, impactContext: null }],
      },
    });
    expect(captured).not.toHaveProperty("fullFile");
    expect(captured).not.toHaveProperty("impactContext");
    expect(captured).not.toHaveProperty("requireEvidence");
  });

  it("checks each finding's evidence against the head files", async () => {
    const reads: string[] = [];
    const result = await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async () =>
        makeReviewOutput({
          findings: [
            evidenceFinding("return sumWithTax(items);"),
            evidenceFinding("legacyFlags[mode]", "src/caller.ts", 3),
          ],
        }),
      ),
      pricing,
      budgetUsd: 10,
      requireEvidence: true,
      readHeadLines: async (path) => {
        reads.push(path);
        return path === "src/total.ts" ? ["return sumWithTax(items);"] : null;
      },
    });
    const [verified, invented] = result.reviews[0]?.findings ?? [];
    expect(verified?.evidenceCheck).toEqual({ verified: 1, checked: 1 });
    expect(invented?.evidenceCheck).toEqual({ verified: 0, checked: 1 });
    expect(reads).toContain("src/caller.ts");
  });

  it("verifies against the hunk text alone without a working tree, and fails a finding with no evidence", async () => {
    const result = await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async () =>
        makeReviewOutput({
          findings: [
            evidenceFinding("sumWithTax(items)"),
            { lineStart: 1, lineEnd: 1, claim: "c", rationale: "r", suggestedSeverity: "minor" },
          ],
        }),
      ),
      pricing,
      budgetUsd: 10,
      requireEvidence: true,
    });
    const [fromHunk, none] = result.reviews[0]?.findings ?? [];
    expect(fromHunk?.evidenceCheck).toEqual({ verified: 1, checked: 1 });
    expect(none?.evidenceCheck).toEqual({ verified: 0, checked: 0 });
  });

  it("never checks evidence when requireEvidence is off", async () => {
    const result = await runReviewStage({
      hunks: [HUNK],
      reviewerPort: fakeReviewer(async () =>
        makeReviewOutput({ findings: [evidenceFinding("not in the code at all")] }),
      ),
      pricing,
      budgetUsd: 10,
    });
    expect(result.reviews[0]?.findings[0]).not.toHaveProperty("evidenceCheck");
  });
});
