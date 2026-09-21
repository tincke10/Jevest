import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFileSpendLedger } from "./local-file-spend-ledger.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevest-ledger-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = {
  periodKey: "2026-09",
  prNumber: 0,
  headSha: "HEAD",
  llmUsd: 0.25,
  jevUsd: 0.0001,
  at: "2026-09-21T16:00:00.000Z",
};

describe("createLocalFileSpendLedger", () => {
  it("reads null when the file does not exist yet", async () => {
    const ledger = createLocalFileSpendLedger({ filePath: join(dir, "nested/spend-ledger.json") });
    expect(await ledger.read()).toBeNull();
  });

  it("records into a new file, creating parent directories, and reads it back", async () => {
    const filePath = join(dir, ".jevest/spend-ledger.json");
    const ledger = createLocalFileSpendLedger({ filePath });

    const after = await ledger.record(entry);
    expect(after).toEqual({ periodKey: "2026-09", spentUsd: 0.2501, runs: 1, updatedAt: entry.at });
    expect(await ledger.read()).toEqual(after);

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    expect(onDisk).toEqual({
      period_key: "2026-09",
      spent_usd: 0.2501,
      runs: 1,
      updated_at: entry.at,
    });
  });

  it("accumulates across records in the same period", async () => {
    const ledger = createLocalFileSpendLedger({ filePath: join(dir, "l.json") });
    await ledger.record(entry);
    const after = await ledger.record({ ...entry, llmUsd: 1 });
    expect(after.spentUsd).toBeCloseTo(1.2502, 6);
    expect(after.runs).toBe(2);
  });

  it("throws on a malformed file instead of silently starting over", async () => {
    const filePath = join(dir, "l.json");
    await writeFile(filePath, "{not json", "utf8");
    const ledger = createLocalFileSpendLedger({ filePath });
    await expect(ledger.read()).rejects.toThrow(/spend ledger/);
  });
});
