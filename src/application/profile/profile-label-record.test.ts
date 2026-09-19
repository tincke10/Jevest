import { describe, expect, it } from "vitest";
import {
  type ProfileLabelRecord,
  ProfileLabelRecordParseError,
  parseProfileLabelRecordLine,
  parseProfileLabelRecordsJsonl,
  serializeProfileLabelRecord,
} from "./profile-label-record.js";

const validRecord: ProfileLabelRecord = {
  hunkId: "zod-abc123-1",
  datasetVersion: 2,
  labels: {
    changeKind: "add-behavior",
    touchesPublicApi: true,
    touchesErrorHandling: false,
    touchesAsync: false,
    touchesIo: false,
  },
  source: "ast-v1",
  needsManualReview: true,
};

function validRecordJson(
  overrides: Record<string, unknown> = {},
  labelOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hunk_id: "zod-abc123-1",
    dataset_version: 2,
    labels: {
      change_kind: "add-behavior",
      touches_public_api: true,
      touches_error_handling: false,
      touches_async: false,
      touches_io: false,
      ...labelOverrides,
    },
    source: "ast-v1",
    needs_manual_review: true,
    ...overrides,
  });
}

describe("serializeProfileLabelRecord / parseProfileLabelRecordLine round-trip", () => {
  it("round-trips a record through serialize then parse", () => {
    const line = serializeProfileLabelRecord(validRecord);
    const parsed = parseProfileLabelRecordLine(line, 1);
    expect(parsed).toEqual(validRecord);
  });

  it("serializes with the exact snake_case wire schema", () => {
    const line = serializeProfileLabelRecord(validRecord);
    const raw = JSON.parse(line);
    expect(raw).toEqual({
      hunk_id: "zod-abc123-1",
      dataset_version: 2,
      labels: {
        change_kind: "add-behavior",
        touches_public_api: true,
        touches_error_handling: false,
        touches_async: false,
        touches_io: false,
      },
      source: "ast-v1",
      needs_manual_review: true,
    });
  });
});

describe("parseProfileLabelRecordLine", () => {
  it("parses a well-formed record", () => {
    expect(parseProfileLabelRecordLine(validRecordJson(), 1)).toEqual(validRecord);
  });

  it("throws with the line number on invalid JSON", () => {
    expect(() => parseProfileLabelRecordLine("{not json", 4)).toThrow(ProfileLabelRecordParseError);
    expect(() => parseProfileLabelRecordLine("{not json", 4)).toThrow(/line 4/);
  });

  it("throws when hunk_id is missing", () => {
    const raw = JSON.parse(validRecordJson());
    raw.hunk_id = undefined;
    expect(() => parseProfileLabelRecordLine(JSON.stringify(raw), 2)).toThrow(/"hunk_id"/);
  });

  it("throws when labels.change_kind is not one of the four known kinds", () => {
    expect(() =>
      parseProfileLabelRecordLine(validRecordJson({}, { change_kind: "rewrite" }), 3),
    ).toThrow(/change_kind/);
  });

  it("throws when a noul label field is not a boolean", () => {
    expect(() =>
      parseProfileLabelRecordLine(validRecordJson({}, { touches_public_api: "yes" }), 3),
    ).toThrow(/touches_public_api/);
  });
});

describe("parseProfileLabelRecordsJsonl", () => {
  it("parses multiple lines in order", () => {
    const content = [
      serializeProfileLabelRecord(validRecord),
      serializeProfileLabelRecord({ ...validRecord, hunkId: "b" }),
    ].join("\n");
    const records = parseProfileLabelRecordsJsonl(content);
    expect(records.map((r) => r.hunkId)).toEqual(["zod-abc123-1", "b"]);
  });

  it("skips blank lines", () => {
    const content = [serializeProfileLabelRecord(validRecord), "", ""].join("\n");
    expect(parseProfileLabelRecordsJsonl(content)).toHaveLength(1);
  });

  it("returns an empty array for empty content", () => {
    expect(parseProfileLabelRecordsJsonl("")).toEqual([]);
  });
});
