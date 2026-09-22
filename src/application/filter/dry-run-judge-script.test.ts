import { describe, expect, it } from "vitest";
import { createFakeFindingJudge } from "../../adapters/judges/fake-finding-judge.js";
import type { FindingJudgeInput } from "../../domain/ports/finding-judge-port.js";
import { generateDryRunJudgeScript } from "./dry-run-judge-script.js";

const INPUT: FindingJudgeInput = {
  findingId: "f1",
  hunkDiff: "d",
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  claim: "c",
  rationale: "r",
};

describe("generateDryRunJudgeScript", () => {
  it("is deterministic for the same seed and finding id, and varies with the seed", async () => {
    const a = await createFakeFindingJudge(generateDryRunJudgeScript(42)).judge(INPUT);
    const b = await createFakeFindingJudge(generateDryRunJudgeScript(42)).judge(INPUT);
    const c = await createFakeFindingJudge(generateDryRunJudgeScript(7)).judge(INPUT);
    expect(a).toEqual(b);
    expect(a.judgment.isRealDefectProb).not.toBe(c.judgment.isRealDefectProb);
  });

  it("produces a well-formed output with a probability in [0, 1], a known severity and zero nominal cost", async () => {
    const out = await createFakeFindingJudge(generateDryRunJudgeScript(1)).judge(INPUT);
    expect(out.judgment.isRealDefectProb).toBeGreaterThanOrEqual(0);
    expect(out.judgment.isRealDefectProb).toBeLessThanOrEqual(1);
    expect(["nit", "minor", "major", "critical"]).toContain(out.judgment.severity);
    expect(out.model).toBe("dry-run-judge");
    expect(out.nominalCostUsd).toBe(0);
  });
});
