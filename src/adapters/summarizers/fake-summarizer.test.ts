import { describe, expect, it } from "vitest";
import type {
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import { UnscriptedPrError, createFakeSummarizer } from "./fake-summarizer.js";

const INPUT: ChangeSummaryInput = {
  prId: "acme/shop#1",
  files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1 }],
};

const OUTPUT: ChangeSummaryOutput = {
  summary: {
    whatChanges: "Changes a.",
    behaviorChanges: [],
    userFacing: false,
    breaking: false,
    areas: ["a"],
    risks: [],
  },
  model: "fake-summarizer",
  usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 1,
};

describe("createFakeSummarizer", () => {
  it("returns the canned output scripted for the pr id", async () => {
    const summarizer = createFakeSummarizer({ "acme/shop#1": OUTPUT });
    await expect(summarizer.summarize(INPUT)).resolves.toEqual(OUTPUT);
  });

  it("rejects with the scripted error", async () => {
    const summarizer = createFakeSummarizer({ "acme/shop#1": new Error("boom") });
    await expect(summarizer.summarize(INPUT)).rejects.toThrow("boom");
  });

  it("throws UnscriptedPrError for an unscripted pr id instead of a silent stub", async () => {
    const summarizer = createFakeSummarizer({});
    await expect(summarizer.summarize(INPUT)).rejects.toThrow(UnscriptedPrError);
  });

  it("accepts a function that computes the output from the input", async () => {
    const summarizer = createFakeSummarizer((input) => ({
      ...OUTPUT,
      summary: { ...OUTPUT.summary, whatChanges: `Touches ${input.files.length} file(s).` },
    }));
    const output = await summarizer.summarize(INPUT);
    expect(output.summary.whatChanges).toBe("Touches 1 file(s).");
  });
});
