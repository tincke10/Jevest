import { describe, expect, it, vi } from "vitest";
import { ReviewerRateLimitError } from "../../adapters/reviewers/reviewer-errors.js";
import { createFakeSummarizer } from "../../adapters/summarizers/fake-summarizer.js";
import type {
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import type { PrRecord } from "./pr-record.js";
import { summarizePrs } from "./summarize-prs.js";

function makeRecord(id: string): PrRecord {
  return {
    id,
    repo: "owner/repo",
    number: Number(id.split("#")[1]),
    title: `Title of ${id}`,
    body: `Body of ${id}`,
    labels: ["bug"],
    author: "someone",
    baseSha: "base",
    headSha: "head",
    mergedAt: "2026-01-01T00:00:00Z",
    files: [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
    ],
    datasetVersion: 1,
  };
}

function makeOutput(prId: string, nominalCostUsd = 0.01): ChangeSummaryOutput {
  return {
    summary: {
      whatChanges: `Changes ${prId}`,
      behaviorChanges: [],
      userFacing: false,
      breaking: false,
      areas: ["a"],
      risks: [],
    },
    model: "fake",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    },
    latencyMs: 5,
    nominalCostUsd,
  };
}

describe("summarizePrs", () => {
  it("summarizes every record into a map keyed by PR id and totals usage", async () => {
    const records = [makeRecord("owner/repo#1"), makeRecord("owner/repo#2")];
    const summarizer = createFakeSummarizer({
      "owner/repo#1": makeOutput("owner/repo#1"),
      "owner/repo#2": makeOutput("owner/repo#2", 0.02),
    });

    const result = await summarizePrs({ records, summarizer });

    expect([...result.summaries.keys()].sort()).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(result.summaries.get("owner/repo#1")?.summary.whatChanges).toBe("Changes owner/repo#1");
    expect(result.failures).toEqual([]);
    expect(result.totals.prsAttempted).toBe(2);
    expect(result.totals.requests).toBe(2);
    expect(result.totals.inputTokens).toBe(200);
    expect(result.totals.cacheInputTokens).toBe(30);
    expect(result.totals.outputTokens).toBe(40);
    expect(result.totals.nominalCostUsd).toBeCloseTo(0.03);
  });

  it("never passes title, body or labels to the summarizer", async () => {
    const seen: ChangeSummaryInput[] = [];
    const summarizer = createFakeSummarizer((input) => {
      seen.push(input);
      return makeOutput(input.prId);
    });

    await summarizePrs({ records: [makeRecord("owner/repo#1")], summarizer });

    expect(seen).toHaveLength(1);
    const input = seen[0] as ChangeSummaryInput;
    expect(Object.keys(input).sort()).toEqual(["files", "prId"]);
    expect(input).not.toHaveProperty("title");
    expect(input).not.toHaveProperty("body");
    expect(input).not.toHaveProperty("labels");
    expect(input.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
    ]);
  });

  it("continues past a failed PR and records the failure", async () => {
    const records = [makeRecord("owner/repo#1"), makeRecord("owner/repo#2")];
    const summarizer = createFakeSummarizer({
      "owner/repo#1": new Error("boom"),
      "owner/repo#2": makeOutput("owner/repo#2"),
    });

    const result = await summarizePrs({ records, summarizer, concurrency: 1 });

    expect(result.failures).toEqual([{ prId: "owner/repo#1", error: "boom" }]);
    expect(result.summaries.has("owner/repo#2")).toBe(true);
    expect(result.totals.prsAttempted).toBe(2);
    expect(result.totals.requests).toBe(1);
  });

  it("runs at most `concurrency` summaries at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const summarizer = createFakeSummarizer(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return makeOutput(input.prId);
    });
    const records = ["1", "2", "3", "4", "5"].map((n) => makeRecord(`owner/repo#${n}`));

    const result = await summarizePrs({ records, summarizer, concurrency: 2 });

    expect(result.summaries.size).toBe(5);
    expect(maxInFlight).toBe(2);
  });

  it("backs off and retries the same PR on a rate limit, then stops the run when retries are exhausted", async () => {
    const attempts: string[] = [];
    const sleep = vi.fn(async () => {});
    const summarizer = createFakeSummarizer((input) => {
      attempts.push(input.prId);
      if (input.prId === "owner/repo#1" && attempts.filter((p) => p === input.prId).length < 2) {
        throw new ReviewerRateLimitError("claude-cli", null);
      }
      if (input.prId === "owner/repo#2") {
        throw new ReviewerRateLimitError("claude-cli", null);
      }
      return makeOutput(input.prId);
    });
    const records = ["1", "2", "3"].map((n) => makeRecord(`owner/repo#${n}`));

    const result = await summarizePrs({
      records,
      summarizer,
      concurrency: 1,
      retry: { maxAttempts: 2, backoffMs: 1000, sleep },
    });

    expect(result.summaries.has("owner/repo#1")).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(result.failures.map((f) => f.prId)).toEqual(["owner/repo#2"]);
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toMatch(/owner\/repo#2/);
    // #3 was never attempted after the persistent rate limit on #2.
    expect(attempts.filter((p) => p === "owner/repo#3")).toHaveLength(0);
    expect(result.totals.prsAttempted).toBe(2);
  });

  it("reports progress after every PR", async () => {
    const onProgress = vi.fn();
    const summarizer = createFakeSummarizer((input) => makeOutput(input.prId));
    const records = ["1", "2"].map((n) => makeRecord(`owner/repo#${n}`));

    await summarizePrs({ records, summarizer, concurrency: 1, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2, prId: "owner/repo#2" });
  });
});
