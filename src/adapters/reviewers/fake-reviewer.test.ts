import { describe, expect, it } from "vitest";
import type { ReviewInput, ReviewOutput } from "../../domain/ports/reviewer-port.js";
import { UnscriptedHunkError, createFakeReviewer } from "./fake-reviewer.js";

const INPUT: ReviewInput = {
  hunkId: "h1",
  file: "src/a.ts",
  language: "typescript",
  hunkHeader: "@@ -1,1 +1,1 @@",
  before: "const a = 1;",
  diff: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
};

const OUTPUT: ReviewOutput = {
  findings: [],
  model: "fake-reviewer",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 0,
};

describe("createFakeReviewer", () => {
  it("returns the scripted output for a known hunk id", async () => {
    const reviewer = createFakeReviewer({ h1: OUTPUT });
    const output = await reviewer.review(INPUT);
    expect(output).toBe(OUTPUT);
  });

  it("throws UnscriptedHunkError for an unknown hunk id", async () => {
    const reviewer = createFakeReviewer({});
    await expect(reviewer.review(INPUT)).rejects.toThrow(UnscriptedHunkError);
    await expect(reviewer.review(INPUT)).rejects.toThrow(/"h1"/);
  });

  it("rejects with the scripted error when the script entry is an Error", async () => {
    const boom = new Error("simulated failure");
    const reviewer = createFakeReviewer({ h1: boom });
    await expect(reviewer.review(INPUT)).rejects.toBe(boom);
  });
});
