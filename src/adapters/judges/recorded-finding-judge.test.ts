import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";
import { createFakeFindingJudge } from "./fake-finding-judge.js";
import {
  MissingJudgeFixtureError,
  createRecordedFindingJudge,
  fixtureKeyForJudgeInput,
} from "./recorded-finding-judge.js";

const INPUT: FindingJudgeInput = {
  findingId: "zod-1::claude-cli::0",
  hunkDiff: "@@ -1,1 +1,1 @@\n-a\n+b",
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  claim: "c",
  rationale: "r",
};

const OUTPUT: FindingJudgeOutput = {
  judgment: { isRealDefectProb: 0.7, severity: "minor", isStyleOnly: false, actionable: true },
  model: "fake-judge",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 5,
};

describe("fixtureKeyForJudgeInput", () => {
  it("is stable for the same input and differs when the claim differs", () => {
    expect(fixtureKeyForJudgeInput(INPUT)).toBe(fixtureKeyForJudgeInput({ ...INPUT }));
    expect(fixtureKeyForJudgeInput(INPUT)).not.toBe(
      fixtureKeyForJudgeInput({ ...INPUT, claim: "other" }),
    );
  });

  it("differs for the same finding id with a different claim (strict vs thorough datasets reuse ids)", () => {
    const strict = fixtureKeyForJudgeInput({ ...INPUT, claim: "strict claim" });
    const thorough = fixtureKeyForJudgeInput({ ...INPUT, claim: "thorough claim" });
    expect(strict).not.toBe(thorough);
  });
});

describe("createRecordedFindingJudge", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-recorded-judge-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("record mode calls the underlying judge, persists a fixture and strips sessionId", async () => {
    const withSession = { ...OUTPUT, sessionId: "session-abc" };
    const judge = createRecordedFindingJudge({
      fixturesDir: dir,
      mode: "record",
      underlying: createFakeFindingJudge({ [INPUT.findingId]: withSession }),
    });

    const output = await judge.judge(INPUT);
    expect(output).toEqual(withSession);

    const raw = await readFile(join(dir, `${fixtureKeyForJudgeInput(INPUT)}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual(OUTPUT);
    expect(raw).not.toContain("session-abc");
  });

  it("record mode resumes: an existing fixture is served without calling the underlying judge", async () => {
    await createRecordedFindingJudge({
      fixturesDir: dir,
      mode: "record",
      underlying: createFakeFindingJudge({ [INPUT.findingId]: OUTPUT }),
    }).judge(INPUT);

    let calls = 0;
    const counting: FindingJudgePort = {
      async judge() {
        calls += 1;
        return { ...OUTPUT, latencyMs: 999 };
      },
    };
    const output = await createRecordedFindingJudge({
      fixturesDir: dir,
      mode: "record",
      underlying: counting,
    }).judge(INPUT);
    expect(calls).toBe(0);
    expect(output).toEqual(OUTPUT);
  });

  it("replay mode reads back a recorded fixture and throws MissingJudgeFixtureError on a miss", async () => {
    await createRecordedFindingJudge({
      fixturesDir: dir,
      mode: "record",
      underlying: createFakeFindingJudge({ [INPUT.findingId]: OUTPUT }),
    }).judge(INPUT);

    const replay = createRecordedFindingJudge({ fixturesDir: dir, mode: "replay" });
    expect(await replay.judge(INPUT)).toEqual(OUTPUT);
    await expect(replay.judge({ ...INPUT, claim: "unrecorded" })).rejects.toThrow(
      MissingJudgeFixtureError,
    );
  });

  it("record mode without an underlying judge throws immediately", () => {
    expect(() => createRecordedFindingJudge({ fixturesDir: dir, mode: "record" })).toThrow(
      /underlying/,
    );
  });
});
