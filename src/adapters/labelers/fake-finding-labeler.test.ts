import { describe, expect, it } from "vitest";
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";
import { UnscriptedLabelError, createFakeFindingLabeler } from "./fake-finding-labeler.js";

const INPUT: FindingLabelerInput = {
  findingId: "zod-1::claude-cli::0",
  claim: "c",
  rationale: "r",
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  hunkHeader: "@@ -1,1 +1,1 @@",
  language: "ts",
  before: "a",
  after: "b",
  commitMessage: "fix: a",
  hunkIsDefect: true,
};

describe("createFakeFindingLabeler", () => {
  it("computes both answers from a function script", async () => {
    const labeler = createFakeFindingLabeler((input, framing) => ({
      framing,
      verdict: framing === "fix-match" ? "real" : "present",
      confidence: 0.5,
      reason: `${input.findingId} ${framing}`,
      model: "fake-labeler",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      latencyMs: 1,
    }));

    expect((await labeler.labelFixMatch(INPUT)).verdict).toBe("real");
    expect((await labeler.labelClaimVerification(INPUT)).verdict).toBe("present");
  });

  it("serves a record script keyed by finding id and framing", async () => {
    const base = {
      confidence: 0.5,
      reason: "scripted",
      model: "fake-labeler",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      latencyMs: 1,
    };
    const labeler = createFakeFindingLabeler({
      "zod-1::claude-cli::0::fix-match": { ...base, framing: "fix-match", verdict: "not-this" },
      "zod-1::claude-cli::0::claim-verification": {
        ...base,
        framing: "claim-verification",
        verdict: "absent",
      },
    });

    expect((await labeler.labelFixMatch(INPUT)).verdict).toBe("not-this");
    expect((await labeler.labelClaimVerification(INPUT)).verdict).toBe("absent");
  });

  it("throws on an unscripted finding rather than falling back to a stub verdict", async () => {
    const labeler = createFakeFindingLabeler({});
    await expect(labeler.labelFixMatch(INPUT)).rejects.toBeInstanceOf(UnscriptedLabelError);
  });

  it("rejects with a scripted Error so failure paths can be tested", async () => {
    const boom = new Error("boom");
    const labeler = createFakeFindingLabeler({ "zod-1::claude-cli::0::fix-match": boom });
    await expect(labeler.labelFixMatch(INPUT)).rejects.toBe(boom);
  });
});
