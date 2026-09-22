import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FindingLabelerInput,
  FindingLabelerPort,
  FixMatchOutput,
} from "../../domain/ports/finding-labeler-port.js";
import { createFakeFindingLabeler } from "./fake-finding-labeler.js";
import {
  MissingLabelFixtureError,
  createRecordedFindingLabeler,
  fixtureKeyForLabelerInput,
} from "./recorded-finding-labeler.js";

const INPUT: FindingLabelerInput = {
  findingId: "zod-1::claude-cli::0",
  claim: "c",
  rationale: "r",
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 1,
  hunkHeader: "@@ -1,1 +1,1 @@",
  language: "ts",
  before: "a",
  after: "b",
  commitMessage: "fix: a",
  hunkIsDefect: true,
};

const OUTPUT: FixMatchOutput = {
  framing: "fix-match",
  verdict: "real",
  confidence: 0.9,
  reason: "the fix changes exactly that",
  model: "fake-labeler",
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  latencyMs: 7,
};

function scripted(overrides: Partial<FixMatchOutput> = {}): FindingLabelerPort {
  return createFakeFindingLabeler((_input, framing) => ({
    ...OUTPUT,
    framing,
    verdict: framing === "fix-match" ? "real" : "present",
    ...overrides,
  }));
}

describe("fixtureKeyForLabelerInput", () => {
  it("is stable for the same input and independent of key insertion order", () => {
    const reordered = { ...INPUT };
    expect(fixtureKeyForLabelerInput(INPUT, "fix-match")).toBe(
      fixtureKeyForLabelerInput(reordered, "fix-match"),
    );
  });

  it("differs per framing, so the two passes never share a fixture", () => {
    expect(fixtureKeyForLabelerInput(INPUT, "fix-match")).not.toBe(
      fixtureKeyForLabelerInput(INPUT, "claim-verification"),
    );
  });

  it("differs when the claim differs, since the thorough dataset reuses finding ids", () => {
    expect(fixtureKeyForLabelerInput(INPUT, "fix-match")).not.toBe(
      fixtureKeyForLabelerInput({ ...INPUT, claim: "other" }, "fix-match"),
    );
  });

  it("differs when the evidence differs, so a re-fetched issue body invalidates the label", () => {
    expect(fixtureKeyForLabelerInput(INPUT, "fix-match")).not.toBe(
      fixtureKeyForLabelerInput({ ...INPUT, issueBody: "new" }, "fix-match"),
    );
  });
});

describe("createRecordedFindingLabeler", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-recorded-labeler-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("record mode calls the underlying labeler, persists a fixture and strips sessionId", async () => {
    const labeler = createRecordedFindingLabeler({
      fixturesDir: dir,
      mode: "record",
      underlying: scripted({ sessionId: "abc-123" }),
    });

    const output = await labeler.labelFixMatch(INPUT);
    expect(output.verdict).toBe("real");

    const path = join(dir, `${fixtureKeyForLabelerInput(INPUT, "fix-match")}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.verdict).toBe("real");
    expect(persisted.framing).toBe("fix-match");
    expect(persisted.sessionId).toBeUndefined();
  });

  it("record mode is resumable: an existing fixture is served without calling the underlying labeler", async () => {
    let calls = 0;
    const counting = createFakeFindingLabeler((_input, framing) => {
      calls += 1;
      return { ...OUTPUT, framing };
    });
    const labeler = createRecordedFindingLabeler({
      fixturesDir: dir,
      mode: "record",
      underlying: counting,
    });

    await labeler.labelFixMatch(INPUT);
    await labeler.labelFixMatch(INPUT);
    expect(calls).toBe(1);
  });

  it("records the two framings as two separate fixtures", async () => {
    const labeler = createRecordedFindingLabeler({
      fixturesDir: dir,
      mode: "record",
      underlying: scripted(),
    });
    await labeler.labelFixMatch(INPUT);
    await labeler.labelClaimVerification(INPUT);
    expect((await readdir(dir)).length).toBe(2);
  });

  it("replay mode reads the recorded answer back", async () => {
    await createRecordedFindingLabeler({
      fixturesDir: dir,
      mode: "record",
      underlying: scripted(),
    }).labelClaimVerification(INPUT);

    const replayed = await createRecordedFindingLabeler({
      fixturesDir: dir,
      mode: "replay",
    }).labelClaimVerification(INPUT);
    expect(replayed.verdict).toBe("present");
    expect(replayed.framing).toBe("claim-verification");
  });

  it("replay mode fails loudly on a miss, naming the framing and the path", async () => {
    const labeler = createRecordedFindingLabeler({ fixturesDir: dir, mode: "replay" });
    const error = await labeler.labelFixMatch(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingLabelFixtureError);
    expect((error as Error).message).toContain(INPUT.findingId);
    expect((error as Error).message).toContain("fix-match");
  });

  it("refuses record mode without an underlying labeler", () => {
    expect(() => createRecordedFindingLabeler({ fixturesDir: dir, mode: "record" })).toThrow(
      /requires an `underlying` labeler/,
    );
  });
});
