import { describe, expect, it } from "vitest";
import {
  createFakeNarrator,
  fakeNarrativeOutput,
} from "../../../adapters/narrators/fake-narrator.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import type { ModelPricing } from "../../findings/pricing.js";
import type { FilteredFinding, FindingFilterStageResult } from "./finding-filter.js";
import type { HunkProfileEntry, HunkProfileStageResult } from "./hunk-profile.js";
import { type NarrateStageInput, narrativeSkipped, runNarrateStage } from "./narrate.js";
import type { ReviewStageEntry, ReviewStageResult } from "./review.js";

const PRICING: ModelPricing = {
  inputPerMTok: 1,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
};

const PR: PullRequestData = {
  ref: { owner: "acme", repo: "shop", number: 7, headSha: "h", baseSha: "b" },
  title: "Apply tax to the checkout total",
  body: "Checkout totals now include tax.",
  author: "dev",
  labels: [],
  baseBranch: "main",
  files: [
    { path: "src/total.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "src/other.ts", status: "modified", additions: 1, deletions: 1 },
    { path: "README.md", status: "modified", additions: 1, deletions: 0 },
  ],
  ciStatus: "success",
};

function hunk(
  id: string,
  file: string,
  overrides: Partial<HunkProfileEntry> = {},
): HunkProfileEntry {
  return {
    id,
    file,
    // One line added before the old line 11, so before-line 11 is after-line 12.
    hunkHeader: "@@ -10,2 +10,3 @@",
    before: "",
    diff: "@@ -10,2 +10,3 @@\n const a = 1;\n+const tax = subtotal * rate;\n const b = 2;",
    oldStart: 10,
    newStart: 10,
    changeKind: "modify-behavior",
    changeKindConfidence: 0.9,
    touchesErrorHandlingProb: 0.1,
    touchesAsyncProb: 0.1,
    containsReviewerInstructionsProb: 0.01,
    touchesPublicApi: false,
    touchesPublicApiPartial: false,
    requestId: "hp",
    latencyMs: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    skippedFromReview: false,
    containsSecret: false,
    profileFailed: false,
    astSkipped: null,
    ...overrides,
  };
}

function reviewEntry(hunkId: string, file: string, error: string | null = null): ReviewStageEntry {
  return {
    hunkId,
    file,
    findings: [],
    model: error === null ? "m" : null,
    usage: null,
    latencyMs: 0,
    requestId: undefined,
    costUsd: 0,
    error,
  };
}

function finding(overrides: Partial<FilteredFinding> = {}): FilteredFinding {
  return {
    findingId: "src/total.ts#0-f0",
    hunkId: "src/total.ts#0",
    file: "src/total.ts",
    lineStart: 11,
    lineEnd: 11,
    claim: "tax is not rounded",
    rationale: "floating point cents",
    isRealDefectProb: 0.97,
    rawIsRealDefectProb: 0.97,
    jevSeverityScore: 2.2,
    isStyleOnlyProb: 0.05,
    actionableProb: 0.9,
    requestId: "ff",
    unverified: false,
    ...overrides,
  };
}

function filterResult(overrides: Partial<FindingFilterStageResult> = {}): FindingFilterStageResult {
  return {
    published: [finding()],
    needsHuman: [
      finding({ findingId: "n", claim: "rate may be undefined", jevSeverityScore: 0.8 }),
    ],
    discarded: [finding({ findingId: "d", claim: "DISCARDED CLAIM" })],
    lowConfidence: [finding({ findingId: "l", claim: "LOW CONFIDENCE CLAIM" })],
    totalRequests: 0,
    totalLatencyMs: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    requestLatenciesMs: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<NarrateStageInput> = {}): NarrateStageInput {
  const hunks = [
    hunk("src/total.ts#0", "src/total.ts"),
    hunk("src/other.ts#0", "src/other.ts", { diff: "@@ -1 +1 @@\n-FAILED HUNK\n+x" }),
    hunk("README.md#0", "README.md", {
      skippedFromReview: true,
      diff: "@@ -1 +1 @@\n+SKIPPED HUNK",
    }),
  ];
  const hunkProfile: HunkProfileStageResult = {
    hunks,
    injectedInstructionsInDiff: { maxProb: 0.01, hunkIds: [] },
    truncatedHunkCount: 0,
    totalRequests: 3,
    totalLatencyMs: 3,
    totalUsage: { inputTokens: 3, outputTokens: 3 },
  };
  const review: ReviewStageResult = {
    reviews: [
      reviewEntry("src/total.ts#0", "src/total.ts"),
      reviewEntry("src/other.ts#0", "src/other.ts", "timeout"),
    ],
    totalCostUsd: 0.01,
    budgetExceeded: false,
    skippedForBudgetCount: 0,
  };
  return {
    pr: PR,
    hunkProfile,
    review,
    findingFilter: filterResult(),
    verdict: { verdict: "fix", published: 1, needsHuman: 1, questions: 1 },
    narrator: createFakeNarrator(() => fakeNarrativeOutput("Review body")),
    language: "es",
    pricing: PRICING,
    ...overrides,
  };
}

describe("runNarrateStage", () => {
  it("hands the narrator the PR text, changed files, the REVIEWED hunks only, and only the kept + needs-human findings", async () => {
    const narrator = createFakeNarrator(() => fakeNarrativeOutput("Review body"));
    await runNarrateStage(makeInput({ narrator }));

    const input = narrator.calls[0]!;
    expect(input.prId).toBe("acme/shop#7");
    expect(input.title).toBe(PR.title);
    expect(input.description).toBe(PR.body);
    expect(input.changedFiles).toEqual(["src/total.ts", "src/other.ts", "README.md"]);
    expect(input.hunks.map((h) => h.file)).toEqual(["src/total.ts"]);
    expect(JSON.stringify(input.hunks)).not.toMatch(/FAILED HUNK|SKIPPED HUNK/);
    expect(input.language).toBe("es");
    expect(input.findings).toEqual([
      {
        file: "src/total.ts",
        line: 12,
        lineEnd: 12,
        claim: "tax is not rounded",
        rationale: "floating point cents",
        severity: "major",
        needsHuman: false,
      },
      expect.objectContaining({
        claim: "rate may be undefined",
        severity: "minor",
        needsHuman: true,
      }),
    ]);
    expect(JSON.stringify(input)).not.toMatch(/DISCARDED CLAIM|LOW CONFIDENCE CLAIM/);
  });

  it("states the verdict the check will carry, with the check title's exact wording in reviewer.language", async () => {
    const lines: string[] = [];
    const cases = [
      { verdict: "fix", published: 2, needsHuman: 0, questions: 0 },
      { verdict: "questions", published: 0, needsHuman: 1, questions: 1 },
      { verdict: "clear", published: 0, needsHuman: 0, questions: 0 },
    ] as const;
    for (const verdict of cases) {
      const narrator = createFakeNarrator(() => fakeNarrativeOutput("x"));
      await runNarrateStage(makeInput({ narrator, verdict }));
      expect(narrator.calls[0]!.verdict).toBe(verdict.verdict);
      lines.push(narrator.calls[0]!.verdictLine);
    }
    expect(lines).toEqual([
      "Corregir 2 problemas antes de mergear",
      "Responder 1 duda (no bloquea)",
      "Nada para corregir",
    ]);

    const english = createFakeNarrator(() => fakeNarrativeOutput("x"));
    await runNarrateStage(makeInput({ narrator: english, verdict: cases[2], language: "en" }));
    expect(english.calls[0]!.verdictLine).toBe("Nothing to fix");
  });

  it("returns the markdown, model, usage and the nominal cost when the adapter reports one", async () => {
    const result = await runNarrateStage(
      makeInput({
        narrator: createFakeNarrator(() =>
          fakeNarrativeOutput("Review body", { model: "claude-opus-5", nominalCostUsd: 0.02 }),
        ),
      }),
    );
    expect(result).toMatchObject({
      markdown: "Review body",
      note: null,
      model: "claude-opus-5",
      costUsd: 0.02,
    });
  });

  it("prices the call from its usage when there is no nominal cost", async () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const result = await runNarrateStage(
      makeInput({
        narrator: createFakeNarrator(() => {
          const { nominalCostUsd: _drop, ...perToken } = fakeNarrativeOutput("x", { usage });
          return perToken;
        }),
      }),
    );
    expect(result.costUsd).toBeCloseTo(2, 10);
    expect(result.usage).toEqual(usage);
  });

  it("never throws: a narrator failure becomes a one-line note and no markdown", async () => {
    const result = await runNarrateStage(
      makeInput({
        narrator: createFakeNarrator(() => {
          throw new Error("anthropic reviewer authentication failed (401);\n  check the key");
        }),
      }),
    );
    expect(result.markdown).toBeNull();
    expect(result.costUsd).toBe(0);
    expect(result.note).toBe(
      "The review narrative failed (anthropic reviewer authentication failed (401); check the key); showing the full Jevest report instead.",
    );
  });
});

describe("narrativeSkipped", () => {
  it("is a zero-cost result with a note saying why", () => {
    expect(narrativeSkipped("per-run budget exhausted")).toEqual({
      markdown: null,
      note: "The review narrative was skipped (per-run budget exhausted); showing the full Jevest report instead.",
      model: null,
      usage: null,
      costUsd: 0,
      latencyMs: 0,
    });
  });
});

describe("runNarrateStage and the author's stated context", () => {
  it("passes the extracted context through, and leaves the key out when there is none", async () => {
    const context = {
      decisions: ["cache of 5 minutes"],
      intendedBehaviorChanges: [],
      outOfScope: [],
      constraints: [],
      references: [],
    };
    const withContext = createFakeNarrator(() => fakeNarrativeOutput("Review body"));
    await runNarrateStage(makeInput({ narrator: withContext, authorContext: context }));
    expect(withContext.calls[0]!.authorContext).toEqual(context);

    const without = createFakeNarrator(() => fakeNarrativeOutput("Review body"));
    await runNarrateStage(makeInput({ narrator: without }));
    expect("authorContext" in without.calls[0]!).toBe(false);
  });
});
