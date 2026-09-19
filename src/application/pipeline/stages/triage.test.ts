import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import type { ConfidencePolicyConfig } from "../../../domain/confidence-policy.js";
import type { Decision } from "../../../domain/decision.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
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
    files: [{ path: "src/paginate.ts", status: "modified", additions: 3, deletions: 1 }],
    ciStatus: "success",
    ...overrides,
  };
}

function script(
  category: string,
  riskScore: number,
  riskConfidence: number,
  needsHuman: number,
  injected: number,
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
    expect(result.riskScore).toBe(1);
    expect(result.needsHumanProb).toBe(0.1);
    expect(result.containsInjectedInstructionsProb).toBe(0.02);
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
    const port = createFakeDecisionAdapter(script("config", 1, 0.9, 0.1, 0.02));
    let capturedState: unknown;
    const spyPort = {
      decide: async (state: unknown, questions: unknown) => {
        capturedState = state;
        return port.decide(state as never, questions as never);
      },
    };
    await runTriageStage({
      pr: makePr({ body: 'API key: apiKey = "sk-abcdefghijklmnopqrstuvwxyz"' }),
      decisionPort: spyPort,
      sizeThresholds,
      policyConfig,
    });
    expect(JSON.stringify(capturedState)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(capturedState)).toContain("REDACTED");
  });
});
