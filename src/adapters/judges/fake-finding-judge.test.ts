import { describe, expect, it } from "vitest";
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
} from "../../domain/ports/finding-judge-port.js";
import { UnscriptedFindingError, createFakeFindingJudge } from "./fake-finding-judge.js";

const INPUT: FindingJudgeInput = {
  findingId: "f1",
  hunkDiff: "@@ -1,1 +1,1 @@\n-a\n+b",
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  claim: "c",
  rationale: "r",
};

const OUTPUT: FindingJudgeOutput = {
  judgment: { isRealDefectProb: 0.7, severity: "minor", isStyleOnly: false, actionable: true },
  model: "fake-judge",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 5,
};

describe("createFakeFindingJudge", () => {
  it("returns the scripted output for a finding id", async () => {
    const judge = createFakeFindingJudge({ f1: OUTPUT });
    expect(await judge.judge(INPUT)).toEqual(OUTPUT);
  });

  it("rejects with a scripted error", async () => {
    const judge = createFakeFindingJudge({ f1: new Error("boom") });
    await expect(judge.judge(INPUT)).rejects.toThrow("boom");
  });

  it("throws UnscriptedFindingError for an unscripted finding id", async () => {
    const judge = createFakeFindingJudge({});
    await expect(judge.judge(INPUT)).rejects.toThrow(UnscriptedFindingError);
  });

  it("accepts a function script computed from the input", async () => {
    const judge = createFakeFindingJudge((input) => ({
      ...OUTPUT,
      judgment: { ...OUTPUT.judgment, isRealDefectProb: input.lineStart / 10 },
    }));
    expect((await judge.judge(INPUT)).judgment.isRealDefectProb).toBe(0.1);
  });
});
