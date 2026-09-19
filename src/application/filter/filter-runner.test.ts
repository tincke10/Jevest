import { describe, expect, it, vi } from "vitest";
import { createFakeDecisionAdapter } from "../../adapters/fake-decision-adapter.js";
import type { Decision } from "../../domain/decision.js";
import { fanOutKey } from "../spike/questions.js";
import { runFilter } from "./filter-runner.js";
import type { FindingRecord } from "./finding-record.js";

function makeFinding(id: string, hunkId: string): FindingRecord {
  return {
    id,
    hunkId,
    datasetVersion: 2,
    reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
    file: "src/thing.ts",
    lineStart: 10,
    lineEnd: 12,
    claim: "off-by-one",
    rationale: "uses <= instead of <",
    suggestedSeverity: "major",
    label: { real: true, source: "line-overlap", overlapLines: 2, fixChangedLines: 3 },
    needsManualReview: true,
    usage: { inputTokens: 400, outputTokens: 60 },
    costUsd: 0.0009,
    latencyMs: 900,
  };
}

function scriptFor(
  findingId: string,
  isReal: number,
  severity: number,
  styleOnly: number,
  actionable: number,
): Record<string, Decision> {
  return {
    [fanOutKey(findingId, "is_real_defect")]: { type: "noul", noul: isReal },
    [fanOutKey(findingId, "severity")]: {
      type: "score",
      score: severity,
      confidence: 0.8,
      legend: { 0: "nit", 1: "minor", 2: "major", 3: "critical" },
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.7, 3: 0.1 },
    },
    [fanOutKey(findingId, "is_style_only")]: { type: "noul", noul: styleOnly },
    [fanOutKey(findingId, "actionable")]: { type: "noul", noul: actionable },
  };
}

const hunkDiffsById = new Map([
  ["h1", "@@ -1,2 +1,2 @@\n-a\n+b"],
  ["h2", "@@ -3,2 +3,2 @@\n-c\n+d"],
]);

describe("runFilter", () => {
  it("maps a noul + score + two nouls per finding into FindingResult", async () => {
    const findings = [makeFinding("f1", "h1")];
    const port = createFakeDecisionAdapter(scriptFor("f1", 0.9, 2, 0.1, 0.8));

    const run = await runFilter({ port, findings, hunkDiffsById, batchSize: 10 });

    expect(run.failures).toEqual([]);
    expect(run.results).toHaveLength(1);
    const [r] = run.results;
    expect(r!.findingId).toBe("f1");
    expect(r!.isRealDefectProb).toBe(0.9);
    expect(r!.severity).toBe(2);
    expect(r!.severityConfidence).toBe(0.8);
    expect(r!.isStyleOnlyProb).toBe(0.1);
    expect(r!.actionableProb).toBe(0.8);
    expect(r!.requestId).toMatch(/^fake_/);
  });

  it("splits into multiple batches and accumulates totals", async () => {
    const findings = [makeFinding("f1", "h1"), makeFinding("f2", "h1"), makeFinding("f3", "h2")];
    const script = {
      ...scriptFor("f1", 0.5, 1, 0.5, 0.5),
      ...scriptFor("f2", 0.5, 1, 0.5, 0.5),
      ...scriptFor("f3", 0.5, 1, 0.5, 0.5),
    };
    const port = createFakeDecisionAdapter(script);

    const run = await runFilter({ port, findings, hunkDiffsById, batchSize: 2 });
    expect(run.results).toHaveLength(3);
    expect(run.totals.requests).toBe(2);
  });

  it("continues past a failed batch and records one failure per finding in it", async () => {
    const findings = [makeFinding("ok1", "h1"), makeFinding("bad1", "h1")];
    const port = createFakeDecisionAdapter(scriptFor("ok1", 0.5, 1, 0.5, 0.5));

    const run = await runFilter({ port, findings, hunkDiffsById, batchSize: 1 });

    expect(run.results).toHaveLength(1);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]!.findingId).toBe("bad1");
    expect(run.failures[0]!.error).toMatch(/no scripted decision/i);
  });

  it("calls onProgress once per batch", async () => {
    const findings = [makeFinding("f1", "h1"), makeFinding("f2", "h1")];
    const script = { ...scriptFor("f1", 0.5, 1, 0.5, 0.5), ...scriptFor("f2", 0.5, 1, 0.5, 0.5) };
    const port = createFakeDecisionAdapter(script);
    const onProgress = vi.fn();

    await runFilter({ port, findings, hunkDiffsById, batchSize: 1, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("measures wall time using an injectable clock", async () => {
    const findings = [makeFinding("f1", "h1")];
    const port = createFakeDecisionAdapter(scriptFor("f1", 0.5, 1, 0.5, 0.5));
    const times = [2000, 2075];
    const now = () => times.shift()!;

    const run = await runFilter({ port, findings, hunkDiffsById, batchSize: 10, now });
    expect(run.totals.wallTimeMs).toBe(75);
  });

  it("propagates a clear error when a finding references an unknown hunk", async () => {
    const findings = [makeFinding("f1", "does-not-exist")];
    const port = createFakeDecisionAdapter({});
    await expect(runFilter({ port, findings, hunkDiffsById, batchSize: 10 })).rejects.toThrow(
      /does-not-exist/,
    );
  });

  it("defaults batchSize to 1 (one finding per request) when omitted", async () => {
    const findings = [makeFinding("f1", "h1"), makeFinding("f2", "h1"), makeFinding("f3", "h2")];
    const script = {
      ...scriptFor("f1", 0.5, 1, 0.5, 0.5),
      ...scriptFor("f2", 0.5, 1, 0.5, 0.5),
      ...scriptFor("f3", 0.5, 1, 0.5, 0.5),
    };
    const port = createFakeDecisionAdapter(script);

    const run = await runFilter({ port, findings, hunkDiffsById });

    expect(run.results).toHaveLength(3);
    expect(run.totals.requests).toBe(3);
  });
});
