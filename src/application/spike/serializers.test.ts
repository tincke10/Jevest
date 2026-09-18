import { describe, expect, it } from "vitest";
import type { HunkRecord } from "./hunk-record.js";
import {
  beforeAfterJson,
  getSerializer,
  jsonWithContext,
  listSerializerNames,
  rawDiff,
} from "./serializers.js";

const hunk: HunkRecord = {
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
    commitMessage: "fix: correct off-by-one that leaked a defect into evidence handling",
    issueUrl: null,
    prUrl: "https://github.com/owner/repo/pull/1",
  },
  needsManualReview: true,
};

describe("rawDiff serializer", () => {
  it("serializes to the diff string only", () => {
    expect(rawDiff.serialize(hunk)).toBe(hunk.diff);
  });

  it("does not leak labels or evidence", () => {
    const serialized = JSON.stringify(rawDiff.serialize(hunk));
    expect(serialized).not.toMatch(/defect/i);
    expect(serialized).not.toMatch(/evidence/i);
    expect(serialized).not.toMatch(/commit_message/i);
  });
});

describe("beforeAfterJson serializer", () => {
  it("serializes to {file, language, before, after}", () => {
    expect(beforeAfterJson.serialize(hunk)).toEqual({
      file: hunk.file,
      language: hunk.language,
      before: hunk.before,
      after: hunk.after,
    });
  });

  it("does not leak labels or evidence", () => {
    const serialized = JSON.stringify(beforeAfterJson.serialize(hunk));
    expect(serialized).not.toMatch(/defect/i);
    expect(serialized).not.toMatch(/evidence/i);
    expect(serialized).not.toMatch(/commit_message/i);
  });
});

describe("jsonWithContext serializer", () => {
  it("serializes to {repo, file, language, hunk_header, before, after, diff}", () => {
    expect(jsonWithContext.serialize(hunk)).toEqual({
      repo: hunk.repo,
      file: hunk.file,
      language: hunk.language,
      hunk_header: hunk.hunkHeader,
      before: hunk.before,
      after: hunk.after,
      diff: hunk.diff,
    });
  });

  it("does not leak labels or evidence", () => {
    const serialized = JSON.stringify(jsonWithContext.serialize(hunk));
    expect(serialized).not.toMatch(/defect/i);
    expect(serialized).not.toMatch(/evidence/i);
    expect(serialized).not.toMatch(/commit_message/i);
  });
});

describe("serializer registry", () => {
  it("lists all three serializer names", () => {
    expect(listSerializerNames().sort()).toEqual([
      "before-after-json",
      "json-with-context",
      "raw-diff",
    ]);
  });

  it("resolves a serializer by name", () => {
    expect(getSerializer("raw-diff")).toBe(rawDiff);
    expect(getSerializer("before-after-json")).toBe(beforeAfterJson);
    expect(getSerializer("json-with-context")).toBe(jsonWithContext);
  });

  it("throws a clear error for an unknown serializer name", () => {
    expect(() => getSerializer("nonexistent")).toThrow(/nonexistent/);
  });
});
