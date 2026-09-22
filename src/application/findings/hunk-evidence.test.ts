import { describe, expect, it } from "vitest";
import {
  HunkEvidenceParseError,
  type HunkEvidenceRecord,
  parseGitHubRef,
  parseHunkEvidenceJsonl,
  stringifyHunkEvidenceRecord,
  truncateEvidenceBody,
} from "./hunk-evidence.js";

const FULL: HunkEvidenceRecord = {
  hunkId: "zod-9446b5c-1",
  issueTitle: "compile() crashes",
  issueBody: "repro here",
  prTitle: "fix(compile): inner ctx",
  prBody: "Closes #6585.",
  fetchedAt: "2026-09-22T12:00:00.000Z",
};

describe("parseHunkEvidenceJsonl", () => {
  it("parses a full record", () => {
    const [record] = parseHunkEvidenceJsonl(`${stringifyHunkEvidenceRecord(FULL)}\n`);
    expect(record).toEqual(FULL);
  });

  it("round-trips: every optional field absent stays absent", () => {
    const minimal: HunkEvidenceRecord = {
      hunkId: "zod-1",
      fetchedAt: "2026-09-22T12:00:00.000Z",
    };
    const line = stringifyHunkEvidenceRecord(minimal);
    expect(line).not.toContain("issue_title");
    expect(parseHunkEvidenceJsonl(line)[0]).toEqual(minimal);
  });

  it("skips blank lines and keeps order", () => {
    const content = [
      stringifyHunkEvidenceRecord({ ...FULL, hunkId: "a" }),
      "",
      stringifyHunkEvidenceRecord({ ...FULL, hunkId: "b" }),
      "",
    ].join("\n");
    expect(parseHunkEvidenceJsonl(content).map((r) => r.hunkId)).toEqual(["a", "b"]);
  });

  it("fails loudly, citing the line number and the field", () => {
    expect(() => parseHunkEvidenceJsonl('{"hunk_id": 3, "fetched_at": "x"}')).toThrow(
      HunkEvidenceParseError,
    );
    expect(() => parseHunkEvidenceJsonl("not json")).toThrow(/line 1/);
    expect(() => parseHunkEvidenceJsonl('{"fetched_at": "x"}')).toThrow(/hunk_id/);
  });
});

describe("parseGitHubRef", () => {
  it("parses an issue URL", () => {
    expect(parseGitHubRef("https://github.com/colinhacks/zod/issues/6585")).toEqual({
      owner: "colinhacks",
      repo: "zod",
      number: 6585,
    });
  });

  it("parses a pull URL", () => {
    expect(parseGitHubRef("https://github.com/vitest-dev/vitest/pull/8123")).toEqual({
      owner: "vitest-dev",
      repo: "vitest",
      number: 8123,
    });
  });

  it("tolerates a trailing slash, a fragment and a query string", () => {
    expect(parseGitHubRef("https://github.com/trpc/trpc/issues/42/?x=1#issuecomment-9")).toEqual({
      owner: "trpc",
      repo: "trpc",
      number: 42,
    });
  });

  it("returns null for anything that is not a GitHub issue or pull URL", () => {
    for (const url of [
      "",
      "not a url",
      "https://gitlab.com/a/b/issues/1",
      "https://github.com/colinhacks/zod",
      "https://github.com/colinhacks/zod/commit/abc",
      "https://github.com/colinhacks/zod/issues/notanumber",
    ]) {
      expect(parseGitHubRef(url)).toBeNull();
    }
  });
});

describe("truncateEvidenceBody", () => {
  it("returns a short body unchanged", () => {
    expect(truncateEvidenceBody("short", 100)).toBe("short");
  });

  it("truncates a long body and says so, so nobody mistakes it for the whole text", () => {
    const truncated = truncateEvidenceBody("x".repeat(500), 100) as string;
    expect(truncated.length).toBeLessThan(160);
    expect(truncated).toContain("truncated");
  });

  it("returns undefined for an empty, whitespace-only or missing body", () => {
    expect(truncateEvidenceBody(undefined, 100)).toBeUndefined();
    expect(truncateEvidenceBody(null, 100)).toBeUndefined();
    expect(truncateEvidenceBody("   \n ", 100)).toBeUndefined();
  });

  it("normalises CRLF so the dataset has one line ending", () => {
    expect(truncateEvidenceBody("a\r\nb", 100)).toBe("a\nb");
  });
});
