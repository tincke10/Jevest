import { describe, expect, it, vi } from "vitest";
import { createFakeDecisionAdapter } from "../../adapters/fake-decision-adapter.js";
import type { Decision } from "../../domain/decision.js";
import type { JsonObject } from "../../domain/json.js";
import type { ChangeSummary } from "../../domain/ports/change-summarizer-port.js";
import type { DecisionPort, State } from "../../domain/ports/decision-port.js";
import { MissingSummaryError, pairIdOf, runCoherenceSpike } from "./coherence-runner.js";
import type { CoherencePair, PrRecord } from "./pr-record.js";

function makeRecord(id: string, title: string): PrRecord {
  return {
    id,
    repo: "owner/repo",
    number: Number(id.split("#")[1]),
    title,
    body: `Body of ${id}`,
    labels: ["area:x"],
    author: "someone",
    baseSha: "base",
    headSha: "head",
    mergedAt: "2026-01-01T00:00:00Z",
    files: [{ path: `src/${title}/index.ts`, status: "modified", additions: 3, deletions: 1 }],
    datasetVersion: 1,
  };
}

const SUMMARY: ChangeSummary = {
  whatChanges: "Adds a thing.",
  behaviorChanges: ["Thing is added."],
  userFacing: true,
  breaking: false,
  areas: ["thing"],
  risks: [],
};

const RECORDS = [makeRecord("owner/repo#1", "alpha"), makeRecord("owner/repo#2", "beta")];
const PAIRS: CoherencePair[] = [
  { prId: "owner/repo#1", descriptionPrId: "owner/repo#1", label: "coherent" },
  { prId: "owner/repo#1", descriptionPrId: "owner/repo#2", label: "incoherent" },
];

function answersFor(matches: number): Record<string, Decision> {
  return {
    matches_intent: { type: "noul", noul: matches },
    user_facing: { type: "noul", noul: 0.7 },
    breaking: { type: "noul", noul: 0.2 },
    needs_product_owner: { type: "noul", noul: 0.4 },
    risk_level: {
      type: "choice",
      choice: "low",
      confidence: 0.6,
      probabilities: { none: 0.1, low: 0.5, medium: 0.2, high: 0.1, critical: 0.1 },
    },
  };
}

function portByIntentTitle(): { port: DecisionPort; states: JsonObject[] } {
  const states: JsonObject[] = [];
  const port = createFakeDecisionAdapter((state: State) => {
    const s = state as JsonObject;
    states.push(s);
    const intent = s.intent as JsonObject;
    return answersFor(intent.title === "alpha" ? 0.9 : 0.1);
  });
  return { port, states };
}

describe("runCoherenceSpike", () => {
  it("asks one request per pair with intent from the description PR and change from the change PR", async () => {
    const { port, states } = portByIntentTitle();
    const decide = vi.spyOn(port, "decide");

    const result = await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: PAIRS,
      summaries: null,
      variant: "without-summary",
    });

    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    expect(result.failures).toEqual([]);

    const coherent = result.results[0]!;
    expect(coherent.pairId).toBe("owner/repo#1|owner/repo#1");
    expect(coherent.label).toBe("coherent");
    expect(coherent.matchesIntent.probability).toBe(0.9);
    expect(coherent.matchesIntent.confidence).toBeCloseTo(0.8);

    const incoherent = result.results[1]!;
    expect(incoherent.pairId).toBe("owner/repo#1|owner/repo#2");
    expect(incoherent.label).toBe("incoherent");
    expect(incoherent.matchesIntent.probability).toBe(0.1);

    // Intent comes from the DESCRIPTION PR, change facts from the CHANGE PR.
    const secondState = states[1]!;
    expect((secondState.intent as JsonObject).title).toBe("beta");
    const facts = secondState.change_facts as JsonObject;
    expect((facts.files as JsonObject[])[0]!.path).toBe("src/alpha/index.ts");
    expect(secondState).not.toHaveProperty("change_summary");
  });

  it("extracts the secondary answers with confidences and request metadata", async () => {
    const { port } = portByIntentTitle();
    const result = await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: [PAIRS[0]!],
      summaries: null,
      variant: "without-summary",
    });

    const r = result.results[0]!;
    expect(r.userFacing).toEqual({ probability: 0.7, confidence: expect.closeTo(0.4, 5) });
    expect(r.breaking.probability).toBe(0.2);
    expect(r.needsProductOwner.probability).toBe(0.4);
    expect(r.riskLevel).toEqual({
      choice: "low",
      confidence: 0.6,
      probabilities: { none: 0.1, low: 0.5, medium: 0.2, high: 0.1, critical: 0.1 },
    });
    expect(r.requestId).toMatch(/^fake_/);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.totals.requests).toBe(1);
  });

  it("with-summary puts the change PR's summary in the state", async () => {
    const { port, states } = portByIntentTitle();
    const summaries = new Map<string, ChangeSummary>([["owner/repo#1", SUMMARY]]);

    const result = await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: PAIRS,
      summaries,
      variant: "with-summary",
    });

    expect(result.failures).toEqual([]);
    for (const state of states) {
      expect((state.change_summary as JsonObject).what_changes).toBe("Adds a thing.");
    }
    expect(result.results[0]!.variant).toBe("with-summary");
  });

  it("with-summary throws a clear error when a summary is missing instead of degrading", async () => {
    const { port } = portByIntentTitle();
    const decide = vi.spyOn(port, "decide");

    await expect(
      runCoherenceSpike({
        port,
        records: RECORDS,
        pairs: PAIRS,
        summaries: new Map(),
        variant: "with-summary",
      }),
    ).rejects.toThrow(MissingSummaryError);
    await expect(
      runCoherenceSpike({
        port,
        records: RECORDS,
        pairs: PAIRS,
        summaries: null,
        variant: "with-summary",
      }),
    ).rejects.toThrow(/owner\/repo#1/);
    expect(decide).not.toHaveBeenCalled();
  });

  it("without-summary ignores provided summaries", async () => {
    const { port, states } = portByIntentTitle();
    await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: [PAIRS[0]!],
      summaries: new Map([["owner/repo#1", SUMMARY]]),
      variant: "without-summary",
    });
    expect(states[0]).not.toHaveProperty("change_summary");
  });

  it("records a failure per pair and continues past it", async () => {
    let calls = 0;
    const port = createFakeDecisionAdapter(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return answersFor(0.5);
    });
    const onProgress = vi.fn();

    const result = await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: PAIRS,
      summaries: null,
      variant: "without-summary",
      onProgress,
    });

    expect(result.failures).toEqual([
      { pairId: "owner/repo#1|owner/repo#1", pairIndex: 0, error: "boom" },
    ]);
    expect(result.results).toHaveLength(1);
    expect(result.totals.requests).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ completedPairs: 2, totalPairs: 2 });
  });

  it("fails the pair (not the run) when a pair references an unknown PR", async () => {
    const { port } = portByIntentTitle();
    const result = await runCoherenceSpike({
      port,
      records: RECORDS,
      pairs: [{ prId: "owner/repo#9", descriptionPrId: "owner/repo#1", label: "incoherent" }],
      summaries: null,
      variant: "without-summary",
    });
    expect(result.results).toEqual([]);
    expect(result.failures[0]!.error).toMatch(/owner\/repo#9/);
  });

  it("pairIdOf joins the change and description ids with a pipe", () => {
    expect(pairIdOf(PAIRS[1]!)).toBe("owner/repo#1|owner/repo#2");
  });
});
