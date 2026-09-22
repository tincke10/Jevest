import { describe, expect, it } from "vitest";
import { createFakeFindingLabeler } from "../../adapters/labelers/fake-finding-labeler.js";
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";
import { generateDryRunLabelerScript } from "./dry-run-labeler-script.js";

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

describe("generateDryRunLabelerScript", () => {
  it("answers in each framing's own vocabulary", async () => {
    const labeler = createFakeFindingLabeler(generateDryRunLabelerScript(42));
    expect(["real", "not-this", "unclear"]).toContain((await labeler.labelFixMatch(INPUT)).verdict);
    expect(["present", "absent", "unclear"]).toContain(
      (await labeler.labelClaimVerification(INPUT)).verdict,
    );
  });

  it("is deterministic for a seed and a finding", async () => {
    const a = createFakeFindingLabeler(generateDryRunLabelerScript(42));
    const b = createFakeFindingLabeler(generateDryRunLabelerScript(42));
    expect((await a.labelFixMatch(INPUT)).verdict).toBe((await b.labelFixMatch(INPUT)).verdict);
  });

  it("gives the two framings independent answers, so agreement is not automatic", async () => {
    const labeler = createFakeFindingLabeler(generateDryRunLabelerScript(7));
    const verdicts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const input = { ...INPUT, findingId: `f${i}` };
      verdicts.add(
        `${(await labeler.labelFixMatch(input)).verdict}::${(await labeler.labelClaimVerification(input)).verdict}`,
      );
    }
    expect(verdicts.size).toBeGreaterThan(3);
  });

  it("costs nothing and names itself, so a dry-run report can never pass for a real one", async () => {
    const output = await createFakeFindingLabeler(generateDryRunLabelerScript(1)).labelFixMatch(
      INPUT,
    );
    expect(output.model).toBe("dry-run-labeler");
    expect(output.nominalCostUsd).toBe(0);
    expect(output.reason).toContain("dry run");
  });
});
