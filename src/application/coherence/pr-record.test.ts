import { describe, expect, it } from "vitest";
import {
  type CoherencePair,
  type PrRecord,
  PrRecordParseError,
  parseCoherencePairsJsonl,
  parsePrRecordsJsonl,
  stringifyCoherencePair,
  stringifyPrRecord,
} from "./pr-record.js";

const RECORD: PrRecord = {
  id: "honojs/hono#1234",
  repo: "honojs/hono",
  number: 1234,
  title: "fix(router): trailing slash matching",
  body: "Routes with a trailing slash were not matched. This normalizes the path before lookup.",
  labels: ["bug"],
  author: "someone",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergedAt: "2026-01-02T03:04:05Z",
  files: [
    {
      path: "src/router.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: "@@ -1,2 +1,4 @@\n-a\n+b\n+c\n+d",
    },
    { path: "src/router.test.ts", status: "added", additions: 20, deletions: 0 },
  ],
  datasetVersion: 1,
};

describe("PrRecord jsonl", () => {
  it("round-trips a record through snake_case JSON", () => {
    const line = stringifyPrRecord(RECORD);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      id: "honojs/hono#1234",
      base_sha: "a".repeat(40),
      merged_at: "2026-01-02T03:04:05Z",
      dataset_version: 1,
    });
    expect(parsePrRecordsJsonl(`${line}\n\n${line}\n`)).toEqual([RECORD, RECORD]);
  });

  it("fails loudly with the line number and field on a bad record", () => {
    const bad = JSON.stringify({ ...JSON.parse(stringifyPrRecord(RECORD)), title: 7 });
    expect(() => parsePrRecordsJsonl(`${stringifyPrRecord(RECORD)}\n${bad}`)).toThrow(
      PrRecordParseError,
    );
    expect(() => parsePrRecordsJsonl(bad)).toThrow(/line 1.*title/);
  });

  it("rejects an unknown file status", () => {
    const raw = JSON.parse(stringifyPrRecord(RECORD));
    raw.files[0].status = "weird";
    expect(() => parsePrRecordsJsonl(JSON.stringify(raw))).toThrow(/files\.0\.status/);
  });
});

describe("CoherencePair jsonl", () => {
  it("round-trips coherent and incoherent pairs", () => {
    const pairs: CoherencePair[] = [
      { prId: "honojs/hono#1", descriptionPrId: "honojs/hono#1", label: "coherent" },
      { prId: "honojs/hono#1", descriptionPrId: "honojs/hono#2", label: "incoherent" },
    ];
    const content = pairs.map(stringifyCoherencePair).join("\n");
    expect(JSON.parse(content.split("\n")[0]!)).toEqual({
      pr_id: "honojs/hono#1",
      description_pr_id: "honojs/hono#1",
      label: "coherent",
    });
    expect(parseCoherencePairsJsonl(content)).toEqual(pairs);
  });

  it("rejects a pair whose label contradicts its ids", () => {
    const same = JSON.stringify({ pr_id: "x#1", description_pr_id: "x#1", label: "incoherent" });
    expect(() => parseCoherencePairsJsonl(same)).toThrow(/label/);
    const different = JSON.stringify({ pr_id: "x#1", description_pr_id: "x#2", label: "coherent" });
    expect(() => parseCoherencePairsJsonl(different)).toThrow(/label/);
  });

  it("round-trips a pair with hard-strategy crossing metadata", () => {
    const pair: CoherencePair = {
      prId: "honojs/hono#1",
      descriptionPrId: "honojs/hono#2",
      label: "incoherent",
      crossing: { strategy: "hard", similarity: 0.6, donorPr: "honojs/hono#2" },
    };
    const line = stringifyCoherencePair(pair);
    expect(JSON.parse(line)).toEqual({
      pr_id: "honojs/hono#1",
      description_pr_id: "honojs/hono#2",
      label: "incoherent",
      crossing: { strategy: "hard", similarity: 0.6, donor_pr: "honojs/hono#2" },
    });
    expect(parseCoherencePairsJsonl(line)).toEqual([pair]);
  });

  it("parses a legacy pair with no crossing field (pre-existing datasets)", () => {
    const legacy = JSON.stringify({ pr_id: "x#1", description_pr_id: "x#2", label: "incoherent" });
    expect(parseCoherencePairsJsonl(legacy)).toEqual([
      { prId: "x#1", descriptionPrId: "x#2", label: "incoherent" },
    ]);
  });
});
