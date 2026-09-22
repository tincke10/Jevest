import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import { createFakeSummarizer } from "../../../adapters/summarizers/fake-summarizer.js";
import type { ConfidencePolicyConfig } from "../../../domain/confidence-policy.js";
import type { Decision } from "../../../domain/decision.js";
import type {
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../../domain/ports/change-summarizer-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { parseProductContext } from "../../context/product-context.js";
import { runTriageStage } from "./triage.js";

const policyConfig: ConfidencePolicyConfig = {
  triage: {
    none: { autoMin: 0.85, confirmMin: 0.55 },
    low: { autoMin: 0.9, confirmMin: 0.6 },
    medium: { autoMin: 0.95, confirmMin: 0.7 },
    high: { autoMin: 0.98, confirmMin: 0.8 },
    critical: { autoMin: 0.99, confirmMin: 0.9 },
  },
};

const sizeThresholds = { smallMaxChangedLines: 20, mediumMaxChangedLines: 200 };

function makePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    ref: { owner: "acme", repo: "widgets", number: 1, headSha: "head", baseSha: "base" },
    title: "Fix off-by-one in pagination",
    body: "Fixes the pagination bug reported in #42.",
    author: "dev",
    labels: [],
    baseBranch: "main",
    files: [
      {
        path: "src/paginate.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "@@ -1,2 +1,4 @@\n-old\n+new",
      },
    ],
    ciStatus: "success",
    ...overrides,
  };
}

interface ScriptOverrides {
  readonly matchesIntent?: number;
  readonly needsProductOwner?: number;
  readonly userFacing?: number;
  readonly breaking?: number;
}

function script(
  category: string,
  riskScore: number,
  riskConfidence: number,
  needsHuman: number,
  injected: number,
  overrides: ScriptOverrides = {},
): Record<string, Decision> {
  return {
    category: {
      type: "choice",
      choice: category,
      confidence: 0.9,
      probabilities: {
        docs: 0,
        deps: 0,
        config: 0,
        refactor: 0,
        feature: 0,
        bugfix: 0,
        security: 0,
        [category]: 1,
      },
    },
    risk: {
      type: "score",
      score: riskScore,
      confidence: riskConfidence,
      legend: { 0: "none", 1: "low", 2: "medium", 3: "high", 4: "critical" },
      probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2 },
    },
    needs_human: { type: "noul", noul: needsHuman },
    contains_injected_instructions: { type: "noul", noul: injected },
    matches_intent: { type: "noul", noul: overrides.matchesIntent ?? 0.9 },
    needs_product_owner: { type: "noul", noul: overrides.needsProductOwner ?? 0.1 },
    user_facing: { type: "noul", noul: overrides.userFacing ?? 0.2 },
    breaking: { type: "noul", noul: overrides.breaking ?? 0.05 },
  };
}

function makeSummaryOutput(overrides: Partial<ChangeSummaryOutput> = {}): ChangeSummaryOutput {
  return {
    summary: {
      whatChanges: "Fixes the page index used when computing the last page.",
      behaviorChanges: ["The last page is no longer skipped."],
      userFacing: true,
      breaking: false,
      areas: ["pagination"],
      risks: [],
    },
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 300,
    requestId: "sum1",
    ...overrides,
  };
}

const CONTEXT = parseProductContext(
  `
product:
  name: Widgets
  description: A catalog of widgets.
areas:
  - name: catalog
    paths: ["src/paginate.ts", "src/catalog/**"]
    criticality: high
    rules: ["Page sizes are capped at 100."]
  - name: docs
    paths: ["docs/**"]
    criticality: none
`,
  "ctx",
);

function capturingPort(scripted: Record<string, Decision>) {
  const captured: { state?: unknown; questions?: Record<string, unknown>; calls: number } = {
    calls: 0,
  };
  const port = createFakeDecisionAdapter(scripted);
  return {
    captured,
    port: {
      decide: async (state: unknown, questions: unknown) => {
        captured.calls += 1;
        captured.state = state;
        captured.questions = questions as Record<string, unknown>;
        return port.decide(state as never, questions as never);
      },
    },
  };
}

describe("runTriageStage", () => {
  it("computes category, risk level, and passes through raw probabilities", async () => {
    const port = createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });

    expect(result.category).toBe("bugfix");
    expect(result.riskLevel).toBe("low");
    expect(result.jevRiskLevel).toBe("low");
    expect(result.riskScore).toBe(1);
    expect(result.needsHumanProb).toBe(0.1);
    expect(result.containsInjectedInstructionsProb).toBe(0.02);
    expect(result.matchesIntentProb).toBe(0.9);
    expect(result.needsProductOwnerProb).toBe(0.1);
    expect(result.userFacingProb).toBe(0.2);
    expect(result.breakingProb).toBe(0.05);
    expect(result.size).toBe("small");
    expect(result.requestId).toMatch(/^fake_/);
  });

  it("classifies size in code from additions/deletions, never asking Jev", async () => {
    const port = createFakeDecisionAdapter(script("feature", 3, 0.9, 0.1, 0.02));
    const result = await runTriageStage({
      pr: makePr({
        files: [{ path: "a.ts", status: "modified", additions: 500, deletions: 100 }],
      }),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.size).toBe("large");
  });

  it("sets needsHumanLabel true whenever needs_human is high, regardless of risk (FR-2.4)", async () => {
    const port = createFakeDecisionAdapter(script("bugfix", 4, 0.99, 0.95, 0.01));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.needsHumanLabel).toBe(true);
  });

  it("skips LLM review when risk is low/none, confidence is auto-band, and injection prob is low (FR-2.3)", async () => {
    const port = createFakeDecisionAdapter(script("docs", 0, 0.95, 0.05, 0.01));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.riskLevel).toBe("none");
    expect(result.skipLlmReview).toBe(true);
  });

  it("does not skip when risk is medium or higher even with high confidence", async () => {
    const port = createFakeDecisionAdapter(script("feature", 2, 0.99, 0.05, 0.01));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.skipLlmReview).toBe(false);
  });

  it("does not skip when confidence band is not auto, even at low risk", async () => {
    const port = createFakeDecisionAdapter(script("docs", 1, 0.65, 0.05, 0.01));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.riskLevel).toBe("low");
    expect(result.skipLlmReview).toBe(false);
  });

  it("does not skip when the injected-instructions probability is above the low bar", async () => {
    const port = createFakeDecisionAdapter(script("docs", 0, 0.95, 0.05, 0.8));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(result.skipLlmReview).toBe(false);
  });

  it("redacts secrets in the PR body before sending", async () => {
    const { port, captured } = capturingPort(script("config", 1, 0.9, 0.1, 0.02));
    await runTriageStage({
      pr: makePr({ body: 'API key: apiKey = "sk-abcdefghijklmnopqrstuvwxyz"' }),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    expect(JSON.stringify(captured.state)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(captured.state)).toContain("REDACTED");
  });
});

describe("runTriageStage v2: three-layer state, product context and change summary (H7)", () => {
  it("sends the H7 three-layer state (intent, change_facts, change_summary) plus a product section, in ONE request (NFR-14)", async () => {
    const { port, captured } = capturingPort(script("bugfix", 1, 0.95, 0.1, 0.02));
    const summarizer = createFakeSummarizer(() => makeSummaryOutput());

    await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
      productContext: CONTEXT,
      summarizer,
    });

    expect(captured.calls).toBe(1);
    const state = captured.state as Record<string, unknown>;
    expect(state).toMatchObject({
      intent: { title: "Fix off-by-one in pagination", labels: [] },
      change_facts: { size: "small", files: [{ path: "src/paginate.ts", kind: "source" }] },
      change_summary: {
        what_changes: "Fixes the page index used when computing the last page.",
        user_facing: true,
      },
      product: {
        name: "Widgets",
        description: "A catalog of widgets.",
        areas_touched: [
          { name: "catalog", criticality: "high", rules: ["Page sizes are capped at 100."] },
        ],
        highest_criticality: "high",
      },
      base_branch: "main",
    });
    // NFR-5: no line counts reach Jev.
    expect(JSON.stringify(state.change_facts)).not.toMatch(/"additions"|"deletions"/);
    expect(Object.keys(captured.questions ?? {}).sort()).toEqual(
      [
        "breaking",
        "category",
        "contains_injected_instructions",
        "matches_intent",
        "needs_human",
        "needs_product_owner",
        "risk",
        "user_facing",
      ].sort(),
    );
  });

  it("omits change_summary entirely (not null) when no summarizer is given, and says no product context is configured", async () => {
    const { port, captured } = capturingPort(script("bugfix", 1, 0.95, 0.1, 0.02));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
    });
    const state = captured.state as Record<string, unknown>;
    expect(state).not.toHaveProperty("change_summary");
    expect(state.product).toMatchObject({ areas_touched: [], highest_criticality: "none" });
    expect(result.changeSummary).toBeNull();
    expect(result.summaryError).toBeNull();
    expect(result.summaryCostUsd).toBe(0);
    expect(result.productContext).toEqual({
      productName: null,
      areas: [],
      maxCriticality: null,
      rules: [],
    });
  });

  it("gives the summarizer files and patches only, keyed by owner/repo#number, never the title or body", async () => {
    const inputs: ChangeSummaryInput[] = [];
    const summarizer = createFakeSummarizer((input) => {
      inputs.push(input);
      return makeSummaryOutput();
    });
    await runTriageStage({
      pr: makePr({ body: "SECRET-NARRATIVE" }),
      decisionPort: createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      summarizer,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      prId: "acme/widgets#1",
      files: [
        {
          path: "src/paginate.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,2 +1,4 @@\n-old\n+new",
        },
      ],
    });
    expect(JSON.stringify(inputs[0])).not.toContain("SECRET-NARRATIVE");
    expect(JSON.stringify(inputs[0])).not.toContain("Fix off-by-one");
  });

  it("runs WITHOUT the summary when the summarizer fails: triage completes, the error is reported, nothing is billed", async () => {
    const { port, captured } = capturingPort(script("bugfix", 1, 0.95, 0.1, 0.02));
    const summarizer = createFakeSummarizer(() => {
      throw new Error("anthropic reviewer rate-limited (429)");
    });
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: port,
      sizeThresholds,
      policyConfig,
      summarizer,
    });
    expect(result.changeSummary).toBeNull();
    expect(result.summaryError).toContain("rate-limited");
    expect(result.summaryCostUsd).toBe(0);
    expect(result.summaryUsage).toBeNull();
    expect(captured.state).not.toHaveProperty("change_summary");
    expect(result.category).toBe("bugfix");
  });

  it("exposes the summary, its model, usage and cost: nominalCostUsd when present", async () => {
    const summarizer = createFakeSummarizer(() =>
      makeSummaryOutput({ nominalCostUsd: 0.0131, model: "claude-opus-5" }),
    );
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      summarizer,
    });
    expect(result.changeSummary?.whatChanges).toContain("page index");
    expect(result.summaryModel).toBe("claude-opus-5");
    expect(result.summaryUsage?.inputTokens).toBe(1_000_000);
    expect(result.summaryCostUsd).toBe(0.0131);
  });

  it("prices the summary from the given pricing table when the adapter reports no nominal cost", async () => {
    const summarizer = createFakeSummarizer(() => makeSummaryOutput());
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      summarizer,
      summaryPricing: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 2.5,
      },
    });
    // 1,000,000 input tokens at $2/MTok.
    expect(result.summaryCostUsd).toBeCloseTo(2, 6);
  });

  it("falls back to the model's own pricing table when no pricing is given", async () => {
    const summarizer = createFakeSummarizer(() => makeSummaryOutput({ model: "claude-opus-5" }));
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      summarizer,
    });
    // Opus 5: $5/MTok input.
    expect(result.summaryCostUsd).toBeCloseTo(5, 6);
  });

  it("raises the effective risk to the highest criticality of the areas touched, keeping Jev's own level", async () => {
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(script("bugfix", 1, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      productContext: CONTEXT,
    });
    expect(result.jevRiskLevel).toBe("low");
    expect(result.riskLevel).toBe("high");
    expect(result.skipLlmReview).toBe(false);
    expect(result.productContext).toEqual({
      productName: "Widgets",
      areas: [
        {
          name: "catalog",
          criticality: "high",
          rules: ["Page sizes are capped at 100."],
          owners: [],
        },
      ],
      maxCriticality: "high",
      rules: ["Page sizes are capped at 100."],
    });
  });

  it("never lowers the risk: a 'none' criticality area leaves Jev's level alone", async () => {
    const result = await runTriageStage({
      pr: makePr({
        files: [{ path: "docs/guide.md", status: "modified", additions: 1, deletions: 0 }],
      }),
      decisionPort: createFakeDecisionAdapter(script("docs", 2, 0.95, 0.1, 0.02)),
      sizeThresholds,
      policyConfig,
      productContext: CONTEXT,
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.productContext.maxCriticality).toBe("none");
  });

  it("flags a description mismatch when P(matches_intent) < 0.35, banding its derived confidence for stage triage", async () => {
    const result = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("bugfix", 1, 0.95, 0.1, 0.02, { matchesIntent: 0.02 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(result.descriptionMismatch).toBe(true);
    // |0.02 - 0.5| * 2 = 0.96 >= autoMin 0.9 for low risk.
    expect(result.descriptionMismatchBand).toBe("auto");
    expect(result.descriptionMatchesChange).toBe("no");
  });

  it("bands a weak mismatch as confirm/escalate rather than auto", async () => {
    const confirm = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("bugfix", 1, 0.95, 0.1, 0.02, { matchesIntent: 0.15 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    // |0.15 - 0.5| * 2 = 0.7: confirm band for low risk (0.6 <= 0.7 < 0.9).
    expect(confirm.descriptionMismatch).toBe(true);
    expect(confirm.descriptionMismatchBand).toBe("confirm");

    const escalate = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("bugfix", 1, 0.95, 0.1, 0.02, { matchesIntent: 0.3 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(escalate.descriptionMismatch).toBe(true);
    expect(escalate.descriptionMismatchBand).toBe("escalate");
  });

  it("reports no mismatch (band null) at P >= 0.35 and maps the merge-gate word: unclear in the middle, yes above 0.65", async () => {
    const unclear = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("bugfix", 1, 0.95, 0.1, 0.02, { matchesIntent: 0.5 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(unclear.descriptionMismatch).toBe(false);
    expect(unclear.descriptionMismatchBand).toBeNull();
    expect(unclear.descriptionMatchesChange).toBe("unclear");

    const yes = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("bugfix", 1, 0.95, 0.1, 0.02, { matchesIntent: 0.9 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(yes.descriptionMatchesChange).toBe("yes");
  });

  it("sets needsProductOwnerLabel at or above the (triage, risk) confirm bar, like needs_human", async () => {
    const flagged = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("feature", 1, 0.95, 0.1, 0.02, { needsProductOwner: 0.7 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(flagged.needsProductOwnerLabel).toBe(true);

    const notFlagged = await runTriageStage({
      pr: makePr(),
      decisionPort: createFakeDecisionAdapter(
        script("feature", 1, 0.95, 0.1, 0.02, { needsProductOwner: 0.3 }),
      ),
      sizeThresholds,
      policyConfig,
    });
    expect(notFlagged.needsProductOwnerLabel).toBe(false);
  });
});
