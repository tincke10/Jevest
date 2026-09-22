import { describe, expect, it } from "vitest";
import {
  FindingRecordParseError,
  parseFindingRecordLine,
  parseFindingRecordsJsonl,
  toOracleLabelWire,
} from "./finding-record.js";

function validFindingJson(
  overrides: Record<string, unknown> = {},
  labelOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: "f1",
    hunk_id: "zod-abc123-1",
    dataset_version: 2,
    reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
    file: "src/thing.ts",
    line_start: 10,
    line_end: 12,
    claim: "off-by-one in the loop bound",
    rationale: "The loop uses <= instead of < against the array length.",
    suggested_severity: "major",
    label: {
      real: true,
      source: "line-overlap",
      overlap_lines: 2,
      fix_changed_lines: 3,
      ...labelOverrides,
    },
    needs_manual_review: true,
    usage: { input_tokens: 400, output_tokens: 60 },
    cost_usd: 0.0009,
    latency_ms: 900,
    ...overrides,
  });
}

describe("parseFindingRecordLine", () => {
  it("accepts anthropic, openai, and claude-cli as reviewer.provider", () => {
    for (const provider of ["anthropic", "openai", "claude-cli"]) {
      const record = parseFindingRecordLine(
        validFindingJson({ reviewer: { provider, model: "m" } }),
        1,
      );
      expect(record.reviewer.provider).toBe(provider);
    }
  });

  it("throws when reviewer.provider is not anthropic, openai, or claude-cli", () => {
    expect(() =>
      parseFindingRecordLine(validFindingJson({ reviewer: { provider: "cohere", model: "m" } }), 6),
    ).toThrow(/reviewer\.provider/);
  });

  it("parses a well-formed record, mapping snake_case fields to camelCase", () => {
    const record = parseFindingRecordLine(validFindingJson(), 1);
    expect(record).toEqual({
      id: "f1",
      hunkId: "zod-abc123-1",
      datasetVersion: 2,
      reviewer: { provider: "anthropic", model: "claude-sonnet-5" },
      file: "src/thing.ts",
      lineStart: 10,
      lineEnd: 12,
      claim: "off-by-one in the loop bound",
      rationale: "The loop uses <= instead of < against the array length.",
      suggestedSeverity: "major",
      label: { real: true, source: "line-overlap", overlapLines: 2, fixChangedLines: 3 },
      needsManualReview: true,
      usage: { inputTokens: 400, outputTokens: 60 },
      costUsd: 0.0009,
      latencyMs: 900,
    });
  });

  it("throws with the line number on invalid JSON", () => {
    expect(() => parseFindingRecordLine("{not json", 5)).toThrow(FindingRecordParseError);
    expect(() => parseFindingRecordLine("{not json", 5)).toThrow(/line 5/);
  });

  it("throws when a required field is missing", () => {
    const raw = JSON.parse(validFindingJson());
    raw.claim = undefined;
    expect(() => parseFindingRecordLine(JSON.stringify(raw), 2)).toThrow(/"claim"/);
  });

  it("throws when suggested_severity is not one of the four known values", () => {
    expect(() =>
      parseFindingRecordLine(validFindingJson({ suggested_severity: "urgent" }), 3),
    ).toThrow(/suggested_severity/);
  });

  it("accepts all four severities", () => {
    for (const severity of ["nit", "minor", "major", "critical"]) {
      const record = parseFindingRecordLine(validFindingJson({ suggested_severity: severity }), 1);
      expect(record.suggestedSeverity).toBe(severity);
    }
  });

  it("throws when label.real is not a boolean", () => {
    expect(() => parseFindingRecordLine(validFindingJson({}, { real: "yes" }), 4)).toThrow(
      /label\.real/,
    );
  });

  it("throws when line_start is not a number", () => {
    expect(() => parseFindingRecordLine(validFindingJson({ line_start: "10" }), 6)).toThrow(
      /line_start/,
    );
  });
});

describe("parseFindingRecordsJsonl", () => {
  it("parses multiple lines in order", () => {
    const content = [validFindingJson({ id: "a" }), validFindingJson({ id: "b" })].join("\n");
    const records = parseFindingRecordsJsonl(content);
    expect(records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips blank lines", () => {
    const content = [validFindingJson(), "", ""].join("\n");
    expect(parseFindingRecordsJsonl(content)).toHaveLength(1);
  });

  it("returns an empty array for empty content", () => {
    expect(parseFindingRecordsJsonl("")).toEqual([]);
  });
});

describe("label.oracle (fix-aware oracle label, FINDINGS.md §10)", () => {
  const ORACLE = {
    verdict: "real",
    source: "fix-oracle",
    labeler_model: "deepseek-v4-pro",
    fix_match: { verdict: "real", confidence: 0.9, reason: "the fix swaps ctx for ctx2" },
    claim_verification: { verdict: "present", confidence: 0.8, reason: "before passes ctx" },
  };

  it("is optional: a record without it parses and has no oracle field at all", () => {
    const record = parseFindingRecordLine(validFindingJson(), 1);
    expect(record.label.oracle).toBeUndefined();
  });

  it("parses the three verdicts and both passes", () => {
    for (const verdict of ["real", "noise", "unknown"]) {
      const record = parseFindingRecordLine(
        validFindingJson({}, { oracle: { ...ORACLE, verdict } }),
        1,
      );
      expect(record.label.oracle).toEqual({
        verdict,
        source: "fix-oracle",
        labelerModel: "deepseek-v4-pro",
        fixMatch: { verdict: "real", confidence: 0.9, reason: "the fix swaps ctx for ctx2" },
        claimVerification: { verdict: "present", confidence: 0.8, reason: "before passes ctx" },
      });
    }
  });

  it("keeps the line-overlap label untouched alongside it", () => {
    const record = parseFindingRecordLine(validFindingJson({}, { oracle: ORACLE }), 1);
    expect(record.label.real).toBe(true);
    expect(record.label.source).toBe("line-overlap");
  });

  it("round-trips through the wire helpers", () => {
    const parsed = parseFindingRecordLine(validFindingJson({}, { oracle: ORACLE }), 1);
    expect(toOracleLabelWire(parsed.label.oracle as never)).toEqual(ORACLE);
  });

  it("rejects an unknown verdict rather than treating it as unknown", () => {
    expect(() =>
      parseFindingRecordLine(validFindingJson({}, { oracle: { ...ORACLE, verdict: "maybe" } }), 7),
    ).toThrow(/label\.oracle\.verdict/);
  });

  it("rejects a missing pass: an oracle label without both readings is not an oracle label", () => {
    const { fix_match: _drop, ...withoutPassA } = ORACLE;
    expect(() => parseFindingRecordLine(validFindingJson({}, { oracle: withoutPassA }), 8)).toThrow(
      /label\.oracle\.fix_match/,
    );
  });

  it("rejects an out-of-range confidence", () => {
    expect(() =>
      parseFindingRecordLine(
        validFindingJson(
          {},
          { oracle: { ...ORACLE, fix_match: { ...ORACLE.fix_match, confidence: 2 } } },
        ),
        9,
      ),
    ).toThrow(/confidence/);
  });
});
