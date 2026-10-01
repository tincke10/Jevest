import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingMatchInput } from "../../domain/ports/finding-matcher-port.js";
import {
  MATCHER_CACHE_VERSION,
  createCachedFindingMatcher,
  matcherCacheKey,
} from "./cached-finding-matcher.js";
import { createFakeFindingMatcher } from "./fake-finding-matcher.js";

const INPUT: FindingMatchInput = {
  goldenIssues: [
    { id: "I2", file: "a.ts", line: 3, title: "Second" },
    { id: "I1", file: "a.ts", line: 1, title: "First" },
  ],
  candidate: { file: "a.ts", line: 2, text: "something" },
};

describe("matcherCacheKey", () => {
  it("ignores issue order but not titles, candidate text or model", () => {
    const reordered = { ...INPUT, goldenIssues: [...INPUT.goldenIssues].reverse() };
    expect(matcherCacheKey(INPUT, "m")).toBe(matcherCacheKey(reordered, "m"));
    expect(matcherCacheKey(INPUT, "m")).not.toBe(matcherCacheKey(INPUT, "other"));
    const retitled = {
      ...INPUT,
      goldenIssues: [{ ...INPUT.goldenIssues[0]!, title: "Changed" }, INPUT.goldenIssues[1]!],
    };
    expect(matcherCacheKey(INPUT, "m")).not.toBe(matcherCacheKey(retitled, "m"));
    const otherText = { ...INPUT, candidate: { ...INPUT.candidate, text: "else" } };
    expect(matcherCacheKey(INPUT, "m")).not.toBe(matcherCacheKey(otherText, "m"));
  });
});

describe("matcherCacheKey v2", () => {
  const key = (input: FindingMatchInput, effort?: string) => matcherCacheKey(input, "m", effort);
  const withIssue = (patch: Record<string, unknown>): FindingMatchInput => ({
    ...INPUT,
    goldenIssues: [{ ...INPUT.goldenIssues[0]!, ...patch }, INPUT.goldenIssues[1]!],
  });

  it("is version 2 and never equals a version-1 key", () => {
    expect(MATCHER_CACHE_VERSION).toBe(2);
    const issues = [...INPUT.goldenIssues]
      .map((issue) => [issue.id, issue.title])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const v1 = createHash("sha256")
      .update(
        JSON.stringify({
          model: "m",
          issues,
          candidate: [INPUT.candidate.file, INPUT.candidate.line, INPUT.candidate.text],
        }),
      )
      .digest("hex");
    expect(key(INPUT)).not.toBe(v1);
  });

  it("changes with everything the prompt shows and with the effort", () => {
    const base = key(INPUT);
    expect(key(withIssue({ notes: "n" }))).not.toBe(base);
    expect(key(withIssue({ category: "security" }))).not.toBe(base);
    expect(key(withIssue({ verdict: "false" }))).not.toBe(base);
    expect(key(withIssue({ locations: [{ file: "b.ts", line: 2 }] }))).not.toBe(base);
    expect(key({ ...INPUT, candidate: { ...INPUT.candidate, failingScenario: "s" } })).not.toBe(
      base,
    );
    expect(
      key({
        ...INPUT,
        candidate: { ...INPUT.candidate, evidence: [{ file: "a.ts", line: 2, quote: "q" }] },
      }),
    ).not.toBe(base);
    expect(key(INPUT, "medium")).not.toBe(base);
    expect(key(INPUT, "medium")).not.toBe(key(INPUT, "high"));
  });
});

describe("createCachedFindingMatcher", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-matcher-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("calls the inner matcher once and replays the decision from disk for free", async () => {
    const decide = vi.fn(() => "I1");
    const inner = createFakeFindingMatcher(decide, 0.02);
    const first = createCachedFindingMatcher({ inner, dir, model: "m" });
    expect(await first.match(INPUT)).toEqual({ issueId: "I1", costUsd: 0.02 });
    const second = createCachedFindingMatcher({ inner, dir, model: "m" });
    expect(await second.match(INPUT)).toEqual({ issueId: "I1", costUsd: 0, cached: true });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("keeps the matcher's reason in the entry and replays it", async () => {
    const inner = {
      match: async () => ({ issueId: "I1", costUsd: 0.1, reason: "same root cause" }),
    };
    const matcher = createCachedFindingMatcher({ inner, dir, model: "m", effort: "medium" });
    await matcher.match(INPUT);
    const [file] = await readdir(dir);
    const entry = JSON.parse(await readFile(join(dir, file as string), "utf8"));
    expect(entry).toMatchObject({ issueId: "I1", model: "m", effort: "medium", version: 2 });
    expect(await matcher.match(INPUT)).toEqual({
      issueId: "I1",
      costUsd: 0,
      cached: true,
      reason: "same root cause",
    });
  });

  it("caches a none decision too", async () => {
    const decide = vi.fn(() => null);
    const matcher = createCachedFindingMatcher({
      inner: createFakeFindingMatcher(decide),
      dir,
      model: "m",
    });
    await matcher.match(INPUT);
    expect(await matcher.match(INPUT)).toEqual({ issueId: null, costUsd: 0, cached: true });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("concurrent matches of the same key leave one intact entry", async () => {
    const matcher = createCachedFindingMatcher({
      inner: createFakeFindingMatcher(() => "I1"),
      dir,
      model: "m",
    });
    await Promise.all(Array.from({ length: 10 }, () => matcher.match(INPUT)));
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect(await matcher.match(INPUT)).toEqual({ issueId: "I1", costUsd: 0, cached: true });
  });
});
