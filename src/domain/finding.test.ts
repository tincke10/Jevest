import { describe, expect, it } from "vitest";
import {
  FindingRecordParseError,
  parseFindingRecordLine,
  parseFindingRecordsJsonl,
  stringifyFindingRecord,
} from "./finding.js";

function validRecordJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "zod-9446b5c-1::anthropic::0",
    hunk_id: "zod-9446b5c-1",
    dataset_version: 2,
    reviewer: { provider: "anthropic", model: "claude-opus-5" },
    file: "packages/zod/src/v4/core/compile.ts",
    line_start: 1270,
    line_end: 1271,
    claim: "The loop never breaks after finding the first match.",
    rationale:
      "Missing break causes O(n^2) behavior and can overwrite the result on a later iteration.",
    suggested_severity: "major",
    label: { real: true, source: "line-overlap", overlap_lines: 2, fix_changed_lines: 3 },
    needs_manual_review: true,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    cost_usd: 0.008,
    latency_ms: 2140,
    ...overrides,
  });
}

describe("parseFindingRecordLine", () => {
  it("parses a well-formed record, mapping snake_case fields to camelCase", () => {
    const record = parseFindingRecordLine(validRecordJson(), 1);
    expect(record).toEqual({
      id: "zod-9446b5c-1::anthropic::0",
      hunkId: "zod-9446b5c-1",
      datasetVersion: 2,
      reviewer: { provider: "anthropic", model: "claude-opus-5" },
      file: "packages/zod/src/v4/core/compile.ts",
      lineStart: 1270,
      lineEnd: 1271,
      claim: "The loop never breaks after finding the first match.",
      rationale:
        "Missing break causes O(n^2) behavior and can overwrite the result on a later iteration.",
      suggestedSeverity: "major",
      label: { real: true, source: "line-overlap", overlapLines: 2, fixChangedLines: 3 },
      needsManualReview: true,
      usage: {
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
      },
      costUsd: 0.008,
      latencyMs: 2140,
    });
  });

  it("throws HunkRecordParseError-style error with the line number on invalid JSON", () => {
    expect(() => parseFindingRecordLine("{not json", 7)).toThrow(FindingRecordParseError);
    expect(() => parseFindingRecordLine("{not json", 7)).toThrow(/line 7/);
  });

  it("throws when the top-level value is not an object", () => {
    expect(() => parseFindingRecordLine("[1,2,3]", 4)).toThrow(/line 4/);
  });

  it("throws with the line number and field name when a required field is missing", () => {
    const json = JSON.parse(validRecordJson());
    json.claim = undefined;
    expect(() => parseFindingRecordLine(JSON.stringify(json), 3)).toThrow(/line 3.*"claim"/s);
  });

  it("throws when a field has the wrong type", () => {
    expect(() => parseFindingRecordLine(validRecordJson({ line_start: "1270" }), 5)).toThrow(
      /"line_start"/,
    );
  });

  it("throws when dataset_version is not 2", () => {
    expect(() => parseFindingRecordLine(validRecordJson({ dataset_version: 1 }), 2)).toThrow(
      /dataset_version/,
    );
  });

  it("throws when reviewer.provider is not anthropic, openai, or claude-cli", () => {
    const json = JSON.parse(validRecordJson());
    json.reviewer.provider = "cohere";
    expect(() => parseFindingRecordLine(JSON.stringify(json), 6)).toThrow(/reviewer\.provider/);
  });

  it("accepts claude-cli as a reviewer provider", () => {
    const record = parseFindingRecordLine(
      validRecordJson({ reviewer: { provider: "claude-cli", model: "claude-opus-5" } }),
      1,
    );
    expect(record.reviewer.provider).toBe("claude-cli");
  });

  it("leaves billing undefined when absent (defaults to api semantically)", () => {
    const record = parseFindingRecordLine(validRecordJson(), 1);
    expect(record.billing).toBeUndefined();
  });

  it("parses billing: subscription when present", () => {
    const record = parseFindingRecordLine(validRecordJson({ billing: "subscription" }), 1);
    expect(record.billing).toBe("subscription");
  });

  it("throws when billing is present but not api or subscription", () => {
    expect(() => parseFindingRecordLine(validRecordJson({ billing: "invoice" }), 12)).toThrow(
      /billing/,
    );
  });

  it("throws when suggested_severity is not one of the four known levels", () => {
    expect(() =>
      parseFindingRecordLine(validRecordJson({ suggested_severity: "urgent" }), 8),
    ).toThrow(/suggested_severity/);
  });

  it("throws when label.source is not line-overlap", () => {
    const json = JSON.parse(validRecordJson());
    json.label.source = "manual";
    expect(() => parseFindingRecordLine(JSON.stringify(json), 9)).toThrow(/label\.source/);
  });

  it("throws when needs_manual_review is not literally true", () => {
    expect(() =>
      parseFindingRecordLine(validRecordJson({ needs_manual_review: false }), 10),
    ).toThrow(/needs_manual_review/);
  });

  it("throws when usage.cache_read_input_tokens is missing", () => {
    const json = JSON.parse(validRecordJson());
    json.usage.cache_read_input_tokens = undefined;
    expect(() => parseFindingRecordLine(JSON.stringify(json), 11)).toThrow(
      /usage\.cache_read_input_tokens/,
    );
  });
});

describe("parseFindingRecordsJsonl", () => {
  it("parses multiple lines in order", () => {
    const content = [validRecordJson({ id: "a" }), validRecordJson({ id: "b" })].join("\n");
    const records = parseFindingRecordsJsonl(content);
    expect(records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips blank lines while keeping correct 1-indexed line numbers for errors", () => {
    const content = [validRecordJson({ id: "a" }), "", "{not json"].join("\n");
    expect(() => parseFindingRecordsJsonl(content)).toThrow(/line 3/);
  });

  it("returns an empty array for empty content", () => {
    expect(parseFindingRecordsJsonl("")).toEqual([]);
  });
});

describe("stringifyFindingRecord", () => {
  it("round-trips through parse, producing the same snake_case shape back", () => {
    const original = JSON.parse(validRecordJson());
    const record = parseFindingRecordLine(validRecordJson(), 1);
    const line = stringifyFindingRecord(record);
    expect(JSON.parse(line)).toEqual(original);
  });

  it("produces a single line with no trailing newline", () => {
    const record = parseFindingRecordLine(validRecordJson(), 1);
    const line = stringifyFindingRecord(record);
    expect(line).not.toContain("\n");
  });

  it("omits billing from the output when absent (round-trip fidelity)", () => {
    const record = parseFindingRecordLine(validRecordJson(), 1);
    const line = stringifyFindingRecord(record);
    expect(JSON.parse(line)).not.toHaveProperty("billing");
  });

  it("includes billing in the output when set to subscription", () => {
    const record = parseFindingRecordLine(validRecordJson({ billing: "subscription" }), 1);
    const line = stringifyFindingRecord(record);
    expect(JSON.parse(line).billing).toBe("subscription");
  });
});

describe("reviewer.prompt_mode", () => {
  it("leaves promptMode undefined when absent (strict by default, pre-2026-09-21 records)", () => {
    const record = parseFindingRecordLine(validRecordJson(), 1);
    expect(record.reviewer.promptMode).toBeUndefined();
  });

  it("parses reviewer.prompt_mode: thorough when present", () => {
    const record = parseFindingRecordLine(
      validRecordJson({
        reviewer: { provider: "claude-cli", model: "claude-opus-5", prompt_mode: "thorough" },
      }),
      1,
    );
    expect(record.reviewer.promptMode).toBe("thorough");
  });

  it("throws when reviewer.prompt_mode is present but unknown", () => {
    expect(() =>
      parseFindingRecordLine(
        validRecordJson({
          reviewer: { provider: "claude-cli", model: "claude-opus-5", prompt_mode: "lenient" },
        }),
        3,
      ),
    ).toThrow(/line 3.*reviewer\.prompt_mode/);
  });

  it("round-trips prompt_mode through stringify and omits it when absent", () => {
    const withMode = validRecordJson({
      reviewer: { provider: "claude-cli", model: "claude-opus-5", prompt_mode: "thorough" },
    });
    expect(stringifyFindingRecord(parseFindingRecordLine(withMode, 1))).toContain(
      '"prompt_mode":"thorough"',
    );
    expect(stringifyFindingRecord(parseFindingRecordLine(validRecordJson(), 1))).not.toContain(
      "prompt_mode",
    );
  });
});
