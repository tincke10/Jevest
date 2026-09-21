import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";
import { createFakeSummarizer } from "./fake-summarizer.js";
import {
  MissingSummaryFixtureError,
  createRecordedSummarizer,
  fixtureNameForPr,
} from "./recorded-summarizer.js";

const INPUT: ChangeSummaryInput = {
  prId: "acme/shop#42",
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "-a\n+b" }],
};

const OUTPUT: ChangeSummaryOutput = {
  summary: {
    whatChanges: "Changes a.",
    behaviorChanges: ["b"],
    userFacing: true,
    breaking: false,
    areas: ["a"],
    risks: [],
  },
  model: "fake-summarizer",
  usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 10,
};

describe("fixtureNameForPr", () => {
  it("sanitizes the pr id into a safe file name", () => {
    expect(fixtureNameForPr("acme/shop#42")).toBe("acme__shop__42");
  });

  it("keeps letters, digits, dots, dashes and underscores", () => {
    expect(fixtureNameForPr("my-org.x/repo_1#7")).toBe("my-org.x__repo_1__7");
  });

  it("never produces a path separator or a leading dot", () => {
    expect(fixtureNameForPr("../../etc#1")).not.toContain("/");
    expect(fixtureNameForPr("../../etc#1").startsWith(".")).toBe(false);
  });
});

describe("createRecordedSummarizer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-recorded-summarizer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("record mode calls the underlying summarizer and persists <sanitized prId>.json", async () => {
    const underlying = createFakeSummarizer({ [INPUT.prId]: OUTPUT });
    const summarizer = createRecordedSummarizer({ fixturesDir: dir, mode: "record", underlying });

    const output = await summarizer.summarize(INPUT);
    expect(output).toEqual(OUTPUT);

    const raw = await readFile(join(dir, "acme__shop__42.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(OUTPUT);
  });

  it("record mode returns sessionId to the caller but never persists it (claude-cli privacy)", async () => {
    const withSession: ChangeSummaryOutput = { ...OUTPUT, sessionId: "session-abc-123" };
    const underlying = createFakeSummarizer({ [INPUT.prId]: withSession });
    const summarizer = createRecordedSummarizer({ fixturesDir: dir, mode: "record", underlying });

    const output = await summarizer.summarize(INPUT);
    expect(output).toEqual(withSession);

    const raw = await readFile(join(dir, `${fixtureNameForPr(INPUT.prId)}.json`), "utf8");
    expect(JSON.parse(raw)).not.toHaveProperty("sessionId");
    expect(raw).not.toContain("session-abc-123");
  });

  it("replay mode reads back a previously recorded fixture with no underlying summarizer", async () => {
    const recorder = createRecordedSummarizer({
      fixturesDir: dir,
      mode: "record",
      underlying: createFakeSummarizer({ [INPUT.prId]: OUTPUT }),
    });
    await recorder.summarize(INPUT);

    const replay = createRecordedSummarizer({ fixturesDir: dir, mode: "replay" });
    await expect(replay.summarize(INPUT)).resolves.toEqual(OUTPUT);
  });

  it("replay mode throws MissingSummaryFixtureError for an unrecorded pr", async () => {
    const replay = createRecordedSummarizer({ fixturesDir: dir, mode: "replay" });
    await expect(replay.summarize(INPUT)).rejects.toThrow(MissingSummaryFixtureError);
  });

  it("record mode without an underlying summarizer throws immediately", () => {
    expect(() => createRecordedSummarizer({ fixturesDir: dir, mode: "record" })).toThrow(
      /underlying/,
    );
  });
});
