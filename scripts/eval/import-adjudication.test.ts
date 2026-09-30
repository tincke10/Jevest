import { describe, expect, it } from "vitest";
import { normalizeImportedReview, parseImportArgs } from "./import-adjudication.js";

describe("parseImportArgs (scripts/eval/import-adjudication.ts)", () => {
  it("parses the required and optional flags", () => {
    expect(
      parseImportArgs([
        "--adjudication",
        "adj",
        "--adjudication-v2",
        "adj2",
        "--meta",
        "meta",
        "--repo",
        "repo.git",
        "--out",
        "golden.jsonl",
        "--base-ref",
        "main",
        "--head-ref",
        "pr/{caseId}",
        "--anchors",
        "local",
        "--export-anchors",
        "baseline",
      ]),
    ).toEqual({
      adjudicationDir: "adj",
      adjudicationV2Dir: "adj2",
      metaDir: "meta",
      repo: "repo.git",
      outPath: "golden.jsonl",
      baseRef: "main",
      headRef: "pr/{caseId}",
      anchorsDir: "local",
      exportAnchorsDir: "baseline",
    });
  });

  it("defaults the refs to the meta's branch names and requires the inputs", () => {
    const options = parseImportArgs([
      "--adjudication",
      "a",
      "--meta",
      "m",
      "--repo",
      "r",
      "--out",
      "o",
    ]);
    expect(options).toMatchObject({ baseRef: null, headRef: null, adjudicationV2Dir: null });
    expect(() => parseImportArgs(["--meta", "m", "--repo", "r", "--out", "o"])).toThrow(
      /--adjudication/,
    );
  });
});

describe("normalizeImportedReview", () => {
  it("keeps only the import-format fields of each finding", () => {
    expect(
      normalizeImportedReview({
        summary: "s",
        findings: [
          {
            id: "L1",
            file: "a.ts",
            line: 3,
            severity: "medium",
            category: "bug",
            claim: "c",
            evidence: "e",
            confidence: 0.8,
            kind: "defect",
          },
        ],
      }),
    ).toEqual({
      findings: [{ file: "a.ts", line: 3, severity: "medium", claim: "c", kind: "defect" }],
    });
  });
});
