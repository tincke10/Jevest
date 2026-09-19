import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewInput, ReviewOutput } from "../../domain/ports/reviewer-port.js";
import { createFakeReviewer } from "./fake-reviewer.js";
import {
  MissingReviewFixtureError,
  createRecordedReviewer,
  fixtureKeyForReview,
} from "./recorded-reviewer.js";

const INPUT: ReviewInput = {
  hunkId: "h1",
  file: "src/a.ts",
  language: "typescript",
  hunkHeader: "@@ -1,1 +1,1 @@",
  before: "const a = 1;",
  diff: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
};

const OUTPUT: ReviewOutput = {
  findings: [{ lineStart: 1, lineEnd: 1, claim: "c", rationale: "r", suggestedSeverity: "nit" }],
  model: "fake-reviewer",
  usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 10,
};

describe("fixtureKeyForReview", () => {
  it("is stable for the same input", () => {
    expect(fixtureKeyForReview(INPUT)).toBe(fixtureKeyForReview({ ...INPUT }));
  });

  it("differs when the hunk id differs", () => {
    expect(fixtureKeyForReview(INPUT)).not.toBe(fixtureKeyForReview({ ...INPUT, hunkId: "h2" }));
  });
});

describe("createRecordedReviewer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-recorded-reviewer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("record mode calls the underlying reviewer and persists a fixture file", async () => {
    const underlying = createFakeReviewer({ h1: OUTPUT });
    const reviewer = createRecordedReviewer({ fixturesDir: dir, mode: "record", underlying });

    const output = await reviewer.review(INPUT);
    expect(output).toEqual(OUTPUT);

    const key = fixtureKeyForReview(INPUT);
    const raw = await readFile(join(dir, `${key}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual(OUTPUT);
  });

  it("record mode returns sessionId to the caller but never persists it to the fixture file (claude-cli privacy)", async () => {
    const outputWithSession: ReviewOutput = { ...OUTPUT, sessionId: "session-abc-123" };
    const underlying = createFakeReviewer({ h1: outputWithSession });
    const reviewer = createRecordedReviewer({ fixturesDir: dir, mode: "record", underlying });

    const output = await reviewer.review(INPUT);
    expect(output).toEqual(outputWithSession);

    const key = fixtureKeyForReview(INPUT);
    const raw = await readFile(join(dir, `${key}.json`), "utf8");
    expect(JSON.parse(raw)).not.toHaveProperty("sessionId");
    expect(raw).not.toContain("session-abc-123");
  });

  it("replay mode reads back a previously recorded fixture with no underlying reviewer", async () => {
    const recorder = createRecordedReviewer({
      fixturesDir: dir,
      mode: "record",
      underlying: createFakeReviewer({ h1: OUTPUT }),
    });
    await recorder.review(INPUT);

    const replay = createRecordedReviewer({ fixturesDir: dir, mode: "replay" });
    const output = await replay.review(INPUT);
    expect(output).toEqual(OUTPUT);
  });

  it("replay mode throws MissingReviewFixtureError for an unrecorded input", async () => {
    const replay = createRecordedReviewer({ fixturesDir: dir, mode: "replay" });
    await expect(replay.review(INPUT)).rejects.toThrow(MissingReviewFixtureError);
  });

  it("record mode without an underlying reviewer throws immediately", () => {
    expect(() => createRecordedReviewer({ fixturesDir: dir, mode: "record" })).toThrow(
      /underlying/,
    );
  });
});
