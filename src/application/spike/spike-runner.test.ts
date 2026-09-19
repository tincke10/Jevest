import { describe, expect, it, vi } from "vitest";
import { createFakeDecisionAdapter } from "../../adapters/fake-decision-adapter.js";
import type { Decision } from "../../domain/decision.js";
import type { HunkRecord } from "./hunk-record.js";
import { fanOutKey } from "./questions.js";
import { runSpike } from "./spike-runner.js";

function makeHunk(id: string): HunkRecord {
  return {
    id,
    repo: "owner/repo",
    license: "MIT",
    commit: "abc123",
    parent: "def456",
    file: "src/thing.ts",
    language: "typescript",
    hunkHeader: "@@ -1,3 +1,4 @@",
    before: "const a = 1;",
    after: "const a = 2;",
    diff: "@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2;",
    label: {
      defect: true,
      category: "bugfix",
      touchesPublicApi: null,
      touchesSecurity: false,
      source: "commit-heuristic",
    },
    evidence: {
      commitMessage: "fix: correct off-by-one",
      issueUrl: null,
      prUrl: "https://github.com/owner/repo/pull/1",
    },
    needsManualReview: true,
    datasetVersion: 1,
  };
}

function scriptFor(
  hunkId: string,
  score: number,
  apiProb: number,
  secProb: number,
): Record<string, Decision> {
  return {
    [fanOutKey(hunkId, "defect_likelihood")]: {
      type: "score",
      score,
      confidence: 0.8,
      legend: { 0: "none", 1: "unlikely", 2: "likely", 3: "certain" },
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.7 },
    },
    [fanOutKey(hunkId, "touches_public_api")]: { type: "noul", noul: apiProb },
    [fanOutKey(hunkId, "touches_security")]: { type: "noul", noul: secProb },
  };
}

describe("runSpike", () => {
  it("runs all hunks in one batch and maps answers into HunkResult", async () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const script = { ...scriptFor("h1", 2.5, 0.9, 0.1), ...scriptFor("h2", 0.2, 0.1, 0.05) };
    const port = createFakeDecisionAdapter(script);

    const run = await runSpike({ port, hunks, serializerName: "before-after-json", batchSize: 10 });

    expect(run.failures).toEqual([]);
    expect(run.results).toHaveLength(2);

    const h1 = run.results.find((r) => r.hunkId === "h1")!;
    expect(h1.defectScore).toBe(2.5);
    expect(h1.defectConfidence).toBe(0.8);
    expect(h1.touchesPublicApi).toBe(0.9);
    expect(h1.touchesSecurity).toBe(0.1);
    expect(h1.serializer).toBe("before-after-json");
    expect(h1.requestId).toMatch(/^fake_/);

    expect(run.totals.requests).toBe(1);
  });

  it("splits into multiple batches per batchSize and accumulates totals across requests", async () => {
    const hunks = [makeHunk("h1"), makeHunk("h2"), makeHunk("h3")];
    const script = {
      ...scriptFor("h1", 1, 0.1, 0.1),
      ...scriptFor("h2", 1, 0.1, 0.1),
      ...scriptFor("h3", 1, 0.1, 0.1),
    };
    const port = createFakeDecisionAdapter(script);

    const run = await runSpike({ port, hunks, serializerName: "raw-diff", batchSize: 2 });

    expect(run.results).toHaveLength(3);
    expect(run.totals.requests).toBe(2); // batch of 2 + batch of 1
  });

  it("continues past a failed batch and records one failure per hunk in it", async () => {
    const hunks = [makeHunk("ok1"), makeHunk("bad1"), makeHunk("bad2")];
    // Only ok1's questions are scripted; bad1/bad2's batch will throw UnscriptedQuestionError.
    const script = scriptFor("ok1", 3, 0.5, 0.5);
    const port = createFakeDecisionAdapter(script);

    const run = await runSpike({ port, hunks, serializerName: "raw-diff", batchSize: 1 });

    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.hunkId).toBe("ok1");
    expect(run.failures).toHaveLength(2);
    expect(run.failures.map((f) => f.hunkId).sort()).toEqual(["bad1", "bad2"]);
    for (const failure of run.failures) {
      expect(failure.error).toMatch(/no scripted decision/i);
    }
  });

  it("calls onProgress once per batch with completed/total counts", async () => {
    const hunks = [makeHunk("h1"), makeHunk("h2"), makeHunk("h3")];
    const script = {
      ...scriptFor("h1", 1, 0.1, 0.1),
      ...scriptFor("h2", 1, 0.1, 0.1),
      ...scriptFor("h3", 1, 0.1, 0.1),
    };
    const port = createFakeDecisionAdapter(script);
    const onProgress = vi.fn();

    await runSpike({ port, hunks, serializerName: "raw-diff", batchSize: 1, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { completedBatches: 1, totalBatches: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(3, { completedBatches: 3, totalBatches: 3 });
  });

  it("measures wall time using an injectable clock", async () => {
    const hunks = [makeHunk("h1")];
    const port = createFakeDecisionAdapter(scriptFor("h1", 1, 0.1, 0.1));
    const times = [5000, 5077];
    const now = () => times.shift()!;

    const run = await runSpike({ port, hunks, serializerName: "raw-diff", batchSize: 10, now });

    expect(run.totals.wallTimeMs).toBe(77);
  });

  it("returns empty results and zero totals for an empty hunk list", async () => {
    const port = createFakeDecisionAdapter({});
    const run = await runSpike({ port, hunks: [], serializerName: "raw-diff", batchSize: 10 });
    expect(run.results).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(run.totals.requests).toBe(0);
  });

  it("defaults batchSize to 1 (one hunk per request) when omitted", async () => {
    // Batch anchoring (docs/analysis/h0-prime-error-analysis.md): packing
    // multiple hunks into one request makes Jev's per-hunk answers
    // converge. Default must be one hunk per request.
    const hunks = [makeHunk("h1"), makeHunk("h2"), makeHunk("h3")];
    const script = {
      ...scriptFor("h1", 1, 0.1, 0.1),
      ...scriptFor("h2", 1, 0.1, 0.1),
      ...scriptFor("h3", 1, 0.1, 0.1),
    };
    const port = createFakeDecisionAdapter(script);

    const run = await runSpike({ port, hunks, serializerName: "raw-diff" });

    expect(run.results).toHaveLength(3);
    expect(run.totals.requests).toBe(3);
  });
});
