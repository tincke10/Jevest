import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingMatchInput } from "../../domain/ports/finding-matcher-port.js";
import { createCachedFindingMatcher, matcherCacheKey } from "./cached-finding-matcher.js";
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
