import { describe, expect, it } from "vitest";
import { HunkRecordParseError, parseHunkRecordLine, parseHunkRecordsJsonl } from "./hunk-record.js";

function validRecordJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "repo-abc123-1",
    repo: "owner/repo",
    license: "MIT",
    commit: "abc123",
    parent: "def456",
    file: "src/thing.ts",
    language: "typescript",
    hunk_header: "@@ -1,3 +1,4 @@",
    before: "const a = 1;",
    after: "const a = 2;",
    diff: "@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2;",
    label: {
      defect: true,
      category: "bugfix",
      touches_public_api: null,
      touches_security: false,
      source: "commit-heuristic",
    },
    evidence: {
      commit_message: "fix: correct off-by-one",
      issue_url: null,
      pr_url: "https://github.com/owner/repo/pull/1",
    },
    needs_manual_review: true,
    ...overrides,
  });
}

describe("parseHunkRecordLine", () => {
  it("parses a well-formed record, mapping snake_case fields to camelCase", () => {
    const record = parseHunkRecordLine(validRecordJson(), 1);
    expect(record).toEqual({
      id: "repo-abc123-1",
      repo: "owner/repo",
      license: "MIT",
      commit: "abc123",
      parent: "def456",
      file: "src/thing.ts",
      language: "typescript",
      hunkHeader: "@@ -1,3 +1,4 @@",
      before: "const a = 1;",
      after: "const a = 2;",
      diff: "@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2;",
      label: {
        defect: true,
        category: "bugfix",
        touchesPublicApi: null,
        touchesSecurity: false,
        source: "commit-heuristic",
      },
      evidence: {
        commitMessage: "fix: correct off-by-one",
        issueUrl: null,
        prUrl: "https://github.com/owner/repo/pull/1",
      },
      needsManualReview: true,
      datasetVersion: 1,
    });
  });

  it("defaults datasetVersion to 1 when dataset_version is absent", () => {
    const record = parseHunkRecordLine(validRecordJson(), 1);
    expect(record.datasetVersion).toBe(1);
  });

  it("parses an explicit dataset_version", () => {
    const record = parseHunkRecordLine(validRecordJson({ dataset_version: 2 }), 1);
    expect(record.datasetVersion).toBe(2);
  });

  it("throws when dataset_version has the wrong type", () => {
    expect(() => parseHunkRecordLine(validRecordJson({ dataset_version: "2" }), 6)).toThrow(
      /"dataset_version"/,
    );
  });

  it("throws HunkRecordParseError with the line number on invalid JSON", () => {
    expect(() => parseHunkRecordLine("{not json", 7)).toThrow(HunkRecordParseError);
    expect(() => parseHunkRecordLine("{not json", 7)).toThrow(/line 7/);
  });

  it("throws with the line number and field name when a required field is missing", () => {
    const json = validRecordJson();
    const withoutFile = JSON.parse(json);
    withoutFile.file = undefined;
    expect(() => parseHunkRecordLine(JSON.stringify(withoutFile), 3)).toThrow(/line 3.*"file"/s);
  });

  it("throws when a field has the wrong type", () => {
    expect(() => parseHunkRecordLine(validRecordJson({ id: 123 }), 5)).toThrow(/"id"/);
  });

  it("throws when label.defect is missing", () => {
    const json = JSON.parse(validRecordJson());
    json.label.defect = undefined;
    expect(() => parseHunkRecordLine(JSON.stringify(json), 2)).toThrow(/label\.defect/);
  });

  it("accepts null for the nullable label fields", () => {
    const record = parseHunkRecordLine(
      validRecordJson({
        label: {
          defect: false,
          category: "docs",
          touches_public_api: null,
          touches_security: null,
          source: "commit-heuristic",
        },
      }),
      1,
    );
    expect(record.label.touchesPublicApi).toBeNull();
    expect(record.label.touchesSecurity).toBeNull();
  });

  it("throws when the top-level value is not an object", () => {
    expect(() => parseHunkRecordLine("[1,2,3]", 4)).toThrow(/line 4/);
  });
});

describe("parseHunkRecordsJsonl", () => {
  it("parses multiple lines in order", () => {
    const content = [validRecordJson({ id: "a" }), validRecordJson({ id: "b" })].join("\n");
    const records = parseHunkRecordsJsonl(content);
    expect(records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips blank lines while keeping correct 1-indexed line numbers for errors", () => {
    const content = [validRecordJson({ id: "a" }), "", "{not json"].join("\n");
    expect(() => parseHunkRecordsJsonl(content)).toThrow(/line 3/);
  });

  it("returns an empty array for empty content", () => {
    expect(parseHunkRecordsJsonl("")).toEqual([]);
  });
});
