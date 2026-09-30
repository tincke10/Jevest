import { describe, expect, it } from "vitest";
import { ImportedReviewError, candidatesFromImportedReview } from "./candidate.js";

describe("candidatesFromImportedReview", () => {
  it("turns every finding into a shown candidate with a stable id", () => {
    const candidates = candidatesFromImportedReview(
      {
        findings: [
          { file: "src/a.ts", line: 3, severity: "high", claim: "Null deref", kind: "defect" },
          { file: "src/b.ts", line: 9, claim: "Why is this async?", kind: "question" },
        ],
      },
      "case-1",
    );
    expect(candidates).toEqual([
      {
        id: "case-1:import:0",
        file: "src/a.ts",
        line: 3,
        text: "Null deref",
        severity: "high",
        kind: "defect",
        bucket: "shown",
        source: "import",
      },
      {
        id: "case-1:import:1",
        file: "src/b.ts",
        line: 9,
        text: "Why is this async?",
        kind: "question",
        bucket: "shown",
        source: "import",
      },
    ]);
  });

  it("accepts a finding without file or line, and a title instead of a claim", () => {
    const [candidate] = candidatesFromImportedReview(
      { findings: [{ title: "General concern" }] },
      "c",
    );
    expect(candidate).toMatchObject({ file: null, line: null, text: "General concern" });
  });

  it("puts a finding marked low into the low bucket", () => {
    const [candidate] = candidatesFromImportedReview(
      { findings: [{ file: "a", line: 1, claim: "x", bucket: "low" }] },
      "c",
    );
    expect(candidate?.bucket).toBe("low");
  });

  it("reads optional cost, tokens and wall time", () => {
    const review = { findings: [], costUsd: 1.5, tokens: 1200, wallTimeMs: 3000 };
    expect(candidatesFromImportedReview(review, "c")).toEqual([]);
  });

  it("rejects a file without a findings array or a finding without text", () => {
    expect(() => candidatesFromImportedReview({}, "c")).toThrow(ImportedReviewError);
    expect(() => candidatesFromImportedReview({ findings: [{ file: "a" }] }, "c")).toThrow(
      /finding 0/,
    );
  });
});
