import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoulDecision } from "../domain/decision.js";
import type { NoulQuestion } from "../domain/question.js";
import { createFakeDecisionAdapter } from "./fake-decision-adapter.js";
import { MissingFixtureError, createRecordedDecisionAdapter } from "./recorded-decision-adapter.js";

let fixturesDir: string;

beforeEach(async () => {
  fixturesDir = await mkdtemp(join(tmpdir(), "jevest-fixtures-"));
});

afterEach(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
});

const flagDecision: NoulDecision = { type: "noul", noul: 0.42 };
const questions = { flag: { type: "noul", instructions: "risky?" } satisfies NoulQuestion };

describe("RecordedDecisionAdapter", () => {
  it("record mode wraps an underlying adapter and writes a fixture file", async () => {
    const underlying = createFakeDecisionAdapter({ flag: flagDecision });
    const adapter = createRecordedDecisionAdapter({ fixturesDir, mode: "record", underlying });

    const response = await adapter.decide("some state", questions);

    expect(response.answers.flag).toEqual(flagDecision);
    const files = await readdir(fixturesDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);

    const written = JSON.parse(await readFile(join(fixturesDir, files[0]!), "utf8"));
    expect(written.answers.flag).toEqual(flagDecision);
  });

  it("replay mode returns a previously recorded fixture without an underlying adapter", async () => {
    const underlying = createFakeDecisionAdapter({ flag: flagDecision });
    const recorder = createRecordedDecisionAdapter({ fixturesDir, mode: "record", underlying });
    await recorder.decide("some state", questions);

    const replayer = createRecordedDecisionAdapter({ fixturesDir, mode: "replay" });
    const response = await replayer.decide("some state", questions);

    expect(response.answers.flag).toEqual(flagDecision);
  });

  it("keys fixtures by a stable hash of (state, questions): different state misses the fixture", async () => {
    const underlying = createFakeDecisionAdapter({ flag: flagDecision });
    const recorder = createRecordedDecisionAdapter({ fixturesDir, mode: "record", underlying });
    await recorder.decide("state A", questions);

    const replayer = createRecordedDecisionAdapter({ fixturesDir, mode: "replay" });
    await expect(replayer.decide("state B", questions)).rejects.toThrow(MissingFixtureError);
  });

  it("replay mode throws a clear error when the fixture is missing", async () => {
    const replayer = createRecordedDecisionAdapter({ fixturesDir, mode: "replay" });
    await expect(replayer.decide("never recorded", questions)).rejects.toThrow(MissingFixtureError);
    await expect(replayer.decide("never recorded", questions)).rejects.toThrow(
      /no recorded fixture/i,
    );
  });

  it("throws at construction when record mode is missing an underlying adapter", () => {
    expect(() => createRecordedDecisionAdapter({ fixturesDir, mode: "record" })).toThrow(
      /requires an .underlying. adapter/,
    );
  });
});
