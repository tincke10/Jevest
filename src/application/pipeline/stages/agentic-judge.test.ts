import { describe, expect, it } from "vitest";
import { createFakeFindingVerifier } from "../../../adapters/agentic/fake-agentic.js";
import { createInMemoryWorkingTree } from "../../../adapters/working-tree/in-memory-working-tree.js";
import type { AgenticFinding } from "../../../domain/agentic-finding.js";
import type { Decision } from "../../../domain/decision.js";
import type { DecisionPort, State } from "../../../domain/ports/decision-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import type { Question } from "../../../domain/question.js";
import { runAgenticJudgeStage } from "./agentic-judge.js";
import { createHeadFileReader } from "./code-context.js";
import { EVIDENCE_NOT_FOUND_REASON } from "./finding-filter.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const HEAD_A = [
  "export function total(items) {",
  "  let sum = 0;",
  "  for (let i = 0; i < items.length - 1; i++) {",
  "    sum += items[i].price;",
  "  }",
  `  const token = "${SECRET}";`,
  "  return sum;",
  "}",
  "",
  "export function unrelated() {",
  "  return 1;",
  "}",
  "// line 13",
  "// line 14",
  "// line 15",
  "// line 16",
  "// line 17",
  "// line 18",
  "// line 19",
  "// line 20",
];

function makePr(): PullRequestData {
  return {
    ref: { owner: "acme", repo: "widgets", number: 7, headSha: "h", baseSha: "b" },
    title: "Totals",
    body: "",
    author: "dev",
    labels: [],
    baseBranch: "main",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: [
          "@@ -1,5 +1,5 @@",
          " export function total(items) {",
          "   let sum = 0;",
          "-  for (let i = 0; i < items.length; i++) {",
          "+  for (let i = 0; i < items.length - 1; i++) {",
          "     sum += items[i].price;",
          "   }",
        ].join("\n"),
      },
    ],
    ciStatus: "success",
  };
}

function finding(overrides: Partial<AgenticFinding> = {}): AgenticFinding {
  return {
    file: "src/a.ts",
    line: 3,
    category: "correctness",
    severity: "high",
    claim: "The loop skips the last item.",
    failingScenario: "items=[{price:1},{price:2}] -> total 1 instead of 3",
    evidence: [{ file: "src/a.ts", line: 3, quote: "for (let i = 0; i < items.length - 1; i++)" }],
    confidence: 0.9,
    ...overrides,
  };
}

interface Script {
  supports?: { choice: string; confidence: number } | Error;
  mechanism?: { choice: string; confidence: number } | Error;
  severity?: { score: number; confidence: number } | Error;
}

function judgePort(script: Script = {}): DecisionPort & {
  calls: { state: State; questions: Record<string, Question> }[];
} {
  const calls: { state: State; questions: Record<string, Question> }[] = [];
  let n = 0;
  return {
    calls,
    async decide(state, questions) {
      calls.push({ state, questions });
      const answers: Record<string, Decision> = {};
      for (const key of Object.keys(questions)) {
        const scripted =
          key === "supports"
            ? (script.supports ?? { choice: "proves", confidence: 0.9 })
            : key === "mechanism"
              ? (script.mechanism ?? { choice: "condition", confidence: 0.8 })
              : (script.severity ?? { score: 2, confidence: 0.7 });
        if (scripted instanceof Error) throw scripted;
        answers[key] =
          "score" in scripted
            ? {
                type: "score",
                score: scripted.score,
                confidence: scripted.confidence,
                legend: {},
                probabilities: {},
              }
            : {
                type: "choice",
                choice: scripted.choice,
                confidence: scripted.confidence,
                probabilities: { [scripted.choice]: scripted.confidence },
              };
      }
      n += 1;
      return {
        requestId: `jev_${n}`,
        model: "jev",
        latencyMs: 5,
        usage: { inputTokens: 10, outputTokens: 1 },
        // biome-ignore lint/suspicious/noExplicitAny: test double
        answers: answers as any,
      };
    },
  };
}

function base(findings: AgenticFinding[], decisionPort: DecisionPort = judgePort()) {
  const tree = createInMemoryWorkingTree({ "src/a.ts": HEAD_A.join("\n") });
  return {
    findings,
    pr: makePr(),
    decisionPort,
    mode: "annotate" as const,
    readHeadLines: createHeadFileReader(tree),
    repoRoot: "/checkout",
    verifierBudgetUsd: 5,
  };
}

describe("runAgenticJudgeStage", () => {
  it("publishes a finding whose evidence is in the code and that Jev judges proves / a mechanism / severity >= 1", async () => {
    const port = judgePort();
    const { filter, details } = await runAgenticJudgeStage(base([finding()], port));
    expect(filter.published).toHaveLength(1);
    const published = filter.published[0];
    expect(published).toMatchObject({
      findingId: "agentic-f0",
      file: "src/a.ts",
      lineStart: 3,
      claim: "The loop skips the last item.",
      rationale: "items=[{price:1},{price:2}] -> total 1 instead of 3",
      jevSeverityScore: 2,
      isRealDefectProb: 0.9,
      unverified: false,
    });
    expect(published?.agentic).toMatchObject({
      category: "correctness",
      reportedSeverity: "high",
      evidenceVerified: 1,
      inlineAnchor: { path: "src/a.ts", line: 3 },
      supports: { choice: "proves", confidence: 0.9 },
      mechanism: { choice: "condition", confidence: 0.8 },
      severity: { score: 2, confidence: 0.7 },
    });
    expect(port.calls.map((c) => Object.keys(c.questions)[0])).toEqual([
      "supports",
      "mechanism",
      "severity",
    ]);
    expect(filter.totalRequests).toBe(3);
    expect(filter.requestLatenciesMs).toEqual([5, 5, 5]);
    expect(filter.totalUsage).toEqual({ inputTokens: 30, outputTokens: 3 });
    expect(details.jevJudgeCalls).toBe(3);
    expect(details.outcomes).toEqual({ published: 1, questions: 0, low: 0, discarded: 0 });
  });

  it("gives Jev the evidence re-read from the checkout, ±5 lines, redacted, plus the claim", async () => {
    const port = judgePort();
    await runAgenticJudgeStage(base([finding()], port));
    const state = port.calls[0]?.state as Record<string, unknown>;
    expect(state.finding).toMatchObject({
      claim: "The loop skips the last item.",
      category: "correctness",
    });
    const evidence = JSON.stringify(state.selectedEvidence);
    expect(evidence).toContain("1| export function total(items) {");
    expect(evidence).toContain("8| }");
    expect(evidence).not.toContain("10| export function unrelated");
    expect(evidence).not.toContain(SECRET);
    expect(evidence).toContain("[REDACTED]");
  });

  it("drops a hard-excluded finding before any judge, with its reason", async () => {
    const port = judgePort();
    const { filter, details } = await runAgenticJudgeStage(
      base([finding({ claim: "There is no rate limiting on this endpoint." })], port),
    );
    expect(port.calls).toHaveLength(0);
    expect(filter.discarded).toHaveLength(1);
    expect(filter.discarded[0]?.rejectedReason).toMatch(/^excluded \(excluded-claim\): /);
    expect(details.dropsByReason).toEqual({ "exclusion:excluded-claim": 1 });
  });

  it("sends a finding whose quotes are not in the code to low confidence (annotate) without asking Jev", async () => {
    const port = judgePort();
    const { filter, details } = await runAgenticJudgeStage(
      base(
        [finding({ evidence: [{ file: "src/a.ts", line: 3, quote: "items.map(x => x * 2)" }] })],
        port,
      ),
    );
    expect(port.calls).toHaveLength(0);
    expect(filter.lowConfidence[0]?.rejectedReason).toBe(EVIDENCE_NOT_FOUND_REASON);
    expect(details.dropsByReason).toEqual({ "evidence-not-found": 1 });
  });

  it("in discard mode, Jev's discards and evidence failures go to discarded", async () => {
    const { filter } = await runAgenticJudgeStage({
      ...base(
        [
          finding({ evidence: [{ file: "src/a.ts", line: 3, quote: "nothing like this exists" }] }),
          finding(),
        ],
        judgePort({ supports: { choice: "noMatch", confidence: 0.9 } }),
      ),
      mode: "discard",
    });
    expect(filter.lowConfidence).toEqual([]);
    expect(filter.discarded.map((f) => f.findingId)).toEqual(["agentic-f0", "agentic-f1"]);
  });

  it("stops the chain at the first discard: noMatch never asks mechanism or severity", async () => {
    const port = judgePort({ supports: { choice: "noMatch", confidence: 0.9 } });
    const { filter, details } = await runAgenticJudgeStage(base([finding()], port));
    expect(port.calls).toHaveLength(1);
    expect(filter.lowConfidence[0]?.rejectedReason).toMatch(/noMatch/);
    expect(details.dropsByReason).toEqual({ "judge:supports-noMatch": 1 });
  });

  it("makes partially supported findings questions", async () => {
    const { filter } = await runAgenticJudgeStage(
      base([finding()], judgePort({ supports: { choice: "partially", confidence: 0.8 } })),
    );
    expect(filter.needsHuman).toHaveLength(1);
    expect(filter.needsHuman[0]?.agentic?.route).toMatch(/partially/);
  });

  it("NFR-2: a Jev failure makes the finding an unverified question, never published", async () => {
    const { filter } = await runAgenticJudgeStage(
      base([finding()], judgePort({ mechanism: new Error("Jev 503") })),
    );
    expect(filter.published).toEqual([]);
    expect(filter.needsHuman).toHaveLength(1);
    expect(filter.needsHuman[0]?.unverified).toBe(true);
  });

  it("puts no inline anchor on a finding outside the diff whose evidence is not on a diff line either", async () => {
    const { filter } = await runAgenticJudgeStage(
      base([
        finding({
          line: 10,
          evidence: [
            { file: "src/a.ts", line: 10, quote: "export function unrelated()" },
            { file: "src/a.ts", line: 30, quote: "does not exist anywhere" },
          ],
        }),
      ]),
    );
    expect(filter.published[0]?.agentic?.inlineAnchor).toBeNull();
  });

  it("anchors on a verified evidence line in the diff when the finding's own line is outside it", async () => {
    const { filter } = await runAgenticJudgeStage(base([finding({ line: 12 })]));
    expect(filter.published[0]?.agentic?.inlineAnchor).toEqual({ path: "src/a.ts", line: 3 });
  });

  describe("with the LLM verifier", () => {
    it("discards a refuted finding with the verifier's reason and never asks Jev", async () => {
      const port = judgePort();
      const verifier = createFakeFindingVerifier(() => "refuted");
      const { filter, details } = await runAgenticJudgeStage({
        ...base([finding()], port),
        verifier,
      });
      expect(port.calls).toHaveLength(0);
      expect(filter.discarded[0]?.rejectedReason).toBe("refuted by the verifier: fake refuted");
      expect(details.verifierCalls).toBe(1);
      expect(details.dropsByReason).toEqual({ "verifier-refuted": 1 });
    });

    it("caps an uncertain finding at a question, and publishes a confirmed one", async () => {
      const verifier = createFakeFindingVerifier((input) =>
        input.finding.line === 3 ? "uncertain" : "confirmed",
      );
      const { filter } = await runAgenticJudgeStage({
        ...base([
          finding(),
          finding({
            line: 4,
            evidence: [{ file: "src/a.ts", line: 4, quote: "sum += items[i].price;" }],
          }),
        ]),
        verifier,
      });
      expect(filter.needsHuman.map((f) => f.findingId)).toEqual(["agentic-f0"]);
      expect(filter.published.map((f) => f.findingId)).toEqual(["agentic-f1"]);
      expect(filter.needsHuman[0]?.agentic?.verifier).toEqual({
        decision: "uncertain",
        reason: "fake uncertain",
      });
    });

    it("treats a verifier error as uncertain, never as confirmed", async () => {
      const verifier = createFakeFindingVerifier(() => new Error("boom"));
      const { filter } = await runAgenticJudgeStage({ ...base([finding()]), verifier });
      expect(filter.needsHuman).toHaveLength(1);
      expect(filter.needsHuman[0]?.agentic?.verifier?.reason).toMatch(/verifier failed: boom/);
    });

    it("does not call the verifier for findings already dropped, and only in the checkout", async () => {
      const verifier = createFakeFindingVerifier();
      await runAgenticJudgeStage({
        ...base([finding({ claim: "Consider adding logging when it fails." }), finding()]),
        verifier,
      });
      expect(verifier.calls).toHaveLength(1);
      expect(verifier.calls[0]?.repoRoot).toBe("/checkout");
      expect(verifier.calls[0]?.itemId).toBe("acme/widgets#7:agentic-f1");
    });

    it("runs at most 3 verifiers at a time", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const verifier = {
        async verify() {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return {
            decision: "confirmed" as const,
            reason: "ok",
            evidence: [],
            model: "v",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            latencyMs: 1,
            nominalCostUsd: 0.01,
            turns: 1,
            toolCalls: [],
          };
        },
      };
      const { details } = await runAgenticJudgeStage({
        ...base(Array.from({ length: 7 }, () => finding())),
        verifier,
      });
      expect(maxInFlight).toBe(3);
      expect(details.verifierCalls).toBe(7);
      expect(details.verifierCostUsd).toBeCloseTo(0.07);
    });

    it("skips the verifier once the budget is spent: the finding stays a question", async () => {
      const verifier = createFakeFindingVerifier();
      const { filter } = await runAgenticJudgeStage({
        ...base([finding()]),
        verifier,
        verifierBudgetUsd: 0,
      });
      expect(verifier.calls).toHaveLength(0);
      expect(filter.needsHuman[0]?.agentic?.verifier?.reason).toMatch(/budget/);
    });
  });
});
