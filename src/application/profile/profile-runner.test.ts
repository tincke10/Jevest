import { describe, expect, it, vi } from "vitest";
import { createFakeDecisionAdapter } from "../../adapters/fake-decision-adapter.js";
import type { Decision } from "../../domain/decision.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { fanOutKey } from "../spike/questions.js";
import { runProfileSpike } from "./profile-runner.js";

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
    evidence: { commitMessage: "fix: x", issueUrl: null, prUrl: null },
    needsManualReview: true,
    datasetVersion: 2,
  };
}

function scriptFor(
  hunkId: string,
  changeKind: string,
  api: number,
  err: number,
  async: number,
  io: number,
): Record<string, Decision> {
  return {
    [fanOutKey(hunkId, "change_kind")]: {
      type: "choice",
      choice: changeKind,
      confidence: 0.8,
      probabilities: {
        "add-behavior": changeKind === "add-behavior" ? 0.7 : 0.1,
        "modify-behavior": changeKind === "modify-behavior" ? 0.7 : 0.1,
        delete: changeKind === "delete" ? 0.7 : 0.1,
        "rename-or-format": changeKind === "rename-or-format" ? 0.7 : 0.1,
      },
    },
    [fanOutKey(hunkId, "touches_public_api")]: { type: "noul", noul: api },
    [fanOutKey(hunkId, "touches_error_handling")]: { type: "noul", noul: err },
    [fanOutKey(hunkId, "touches_async")]: { type: "noul", noul: async },
    [fanOutKey(hunkId, "touches_io")]: { type: "noul", noul: io },
  };
}

describe("runProfileSpike", () => {
  it("maps a choice + four nouls per hunk into ProfileHunkResult", async () => {
    const hunks = [makeHunk("h1")];
    const port = createFakeDecisionAdapter(scriptFor("h1", "add-behavior", 0.9, 0.1, 0.2, 0.3));

    const run = await runProfileSpike({ port, hunks, serializerName: "raw-diff", batchSize: 10 });

    expect(run.failures).toEqual([]);
    expect(run.results).toHaveLength(1);
    const [r] = run.results;
    expect(r!.hunkId).toBe("h1");
    expect(r!.serializer).toBe("raw-diff");
    expect(r!.changeKind).toBe("add-behavior");
    expect(r!.changeKindConfidence).toBe(0.8);
    expect(r!.touchesPublicApi).toBe(0.9);
    expect(r!.touchesErrorHandling).toBe(0.1);
    expect(r!.touchesAsync).toBe(0.2);
    expect(r!.touchesIo).toBe(0.3);
    expect(r!.requestId).toMatch(/^fake_/);
  });

  it("splits into multiple batches and accumulates totals", async () => {
    const hunks = [makeHunk("h1"), makeHunk("h2"), makeHunk("h3")];
    const script = {
      ...scriptFor("h1", "delete", 0.1, 0.1, 0.1, 0.1),
      ...scriptFor("h2", "delete", 0.1, 0.1, 0.1, 0.1),
      ...scriptFor("h3", "delete", 0.1, 0.1, 0.1, 0.1),
    };
    const port = createFakeDecisionAdapter(script);

    const run = await runProfileSpike({ port, hunks, serializerName: "raw-diff", batchSize: 2 });
    expect(run.results).toHaveLength(3);
    expect(run.totals.requests).toBe(2);
  });

  it("continues past a failed batch and records one failure per hunk in it", async () => {
    const hunks = [makeHunk("ok1"), makeHunk("bad1")];
    const port = createFakeDecisionAdapter(scriptFor("ok1", "modify-behavior", 0.1, 0.1, 0.1, 0.1));

    const run = await runProfileSpike({ port, hunks, serializerName: "raw-diff", batchSize: 1 });

    expect(run.results).toHaveLength(1);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]!.hunkId).toBe("bad1");
    expect(run.failures[0]!.error).toMatch(/no scripted decision/i);
  });

  it("calls onProgress once per batch", async () => {
    const hunks = [makeHunk("h1"), makeHunk("h2")];
    const script = {
      ...scriptFor("h1", "delete", 0.1, 0.1, 0.1, 0.1),
      ...scriptFor("h2", "delete", 0.1, 0.1, 0.1, 0.1),
    };
    const port = createFakeDecisionAdapter(script);
    const onProgress = vi.fn();

    await runProfileSpike({ port, hunks, serializerName: "raw-diff", batchSize: 1, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("measures wall time using an injectable clock", async () => {
    const hunks = [makeHunk("h1")];
    const port = createFakeDecisionAdapter(scriptFor("h1", "delete", 0.1, 0.1, 0.1, 0.1));
    const times = [1000, 1050];
    const now = () => times.shift()!;

    const run = await runProfileSpike({
      port,
      hunks,
      serializerName: "raw-diff",
      batchSize: 10,
      now,
    });
    expect(run.totals.wallTimeMs).toBe(50);
  });
});
