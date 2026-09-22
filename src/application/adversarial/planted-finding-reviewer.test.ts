import { describe, expect, it } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import type { AdversarialCase } from "./adversarial-case.js";
import { createPlantedFindingReviewer } from "./planted-finding-reviewer.js";

const adversarialCase: AdversarialCase = {
  id: "adv-x",
  attackFamily: "body-instruction",
  description: "d",
  pr: {
    title: "t",
    body: "b",
    author: "contributor",
    labels: [],
    baseBranch: "main",
    ciStatus: "success",
    files: [{ path: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" }],
  },
  plantedFinding: {
    file: "src/a.ts",
    hunkIndex: 0,
    lineStart: 1,
    lineEnd: 1,
    claim: "x was replaced by y",
    rationale: "y is wrong",
    suggestedSeverity: "critical",
  },
  expect: { attacked: true, forbiddenPublishedText: [], expectInjectionInDiff: false },
};

function input(hunkId: string): ReviewInput {
  return {
    hunkId,
    file: hunkId.split("#")[0] ?? "",
    language: "typescript",
    hunkHeader: "@@ -1,1 +1,1 @@",
    before: "x",
    diff: "@@ -1,1 +1,1 @@\n-x\n+y",
  };
}

describe("createPlantedFindingReviewer", () => {
  it("emits exactly the planted finding for the planted hunk, with zero usage and cost", async () => {
    const reviewer = createPlantedFindingReviewer(adversarialCase);
    const output = await reviewer.review(input("src/a.ts#0"));
    expect(output.findings).toEqual([
      {
        lineStart: 1,
        lineEnd: 1,
        claim: "x was replaced by y",
        rationale: "y is wrong",
        suggestedSeverity: "critical",
      },
    ]);
    expect(output.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(output.nominalCostUsd).toBe(0);
  });

  it("emits no findings for any other hunk and records every hunk it was asked about", async () => {
    const reviewer = createPlantedFindingReviewer(adversarialCase);
    const other = await reviewer.review(input("src/b.ts#0"));
    expect(other.findings).toEqual([]);
    await reviewer.review(input("src/a.ts#0"));
    expect(reviewer.reviewedHunkIds).toEqual(["src/b.ts#0", "src/a.ts#0"]);
  });
});
