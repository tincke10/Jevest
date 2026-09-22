import { describe, expect, it } from "vitest";
import type { OracleLabelResult } from "../../src/application/findings/oracle-label.js";
import { applyOracleLabelToLine, evidenceKeyForHunk, parseArgs } from "./label.js";

describe("parseArgs", () => {
  it("requires --labeler", () => {
    expect(() => parseArgs([])).toThrow(/--labeler/);
  });

  it("defaults to replay mode, concurrency 2 and the deepseek-v4-pro model", () => {
    const options = parseArgs(["--labeler", "deepseek"]);
    expect(options.mode).toBe("replay");
    expect(options.concurrency).toBe(2);
    expect(options.model).toBe("deepseek-v4-pro");
  });

  it("parses a full record run", () => {
    const options = parseArgs([
      "--findings",
      "datasets/findings-thorough.jsonl",
      "--out",
      "datasets/findings-thorough-oracle.jsonl",
      "--labeler",
      "deepseek",
      "--mode",
      "record",
      "--concurrency",
      "4",
      "--model",
      "deepseek-flash",
      "--max-tokens",
      "16384",
    ]);
    expect(options.maxTokens).toBe(16384);
    expect(options.findingsPath).toBe("datasets/findings-thorough.jsonl");
    expect(options.outPath).toBe("datasets/findings-thorough-oracle.jsonl");
    expect(options.labeler).toBe("deepseek");
    expect(options.mode).toBe("record");
    expect(options.concurrency).toBe(4);
    expect(options.model).toBe("deepseek-flash");
  });

  it("accepts the dry-run labeler and dry-run mode", () => {
    const options = parseArgs(["--labeler", "dry-run", "--mode", "dry-run"]);
    expect(options.labeler).toBe("dry-run");
    expect(options.mode).toBe("dry-run");
  });

  it("defaults maxTokens to undefined (the adapter's default) and rejects a non-positive --max-tokens", () => {
    expect(parseArgs(["--labeler", "deepseek"]).maxTokens).toBeUndefined();
    expect(() => parseArgs(["--labeler", "deepseek", "--max-tokens", "0"])).toThrow(/--max-tokens/);
    expect(() => parseArgs(["--labeler", "deepseek", "--max-tokens", "lots"])).toThrow(
      /--max-tokens/,
    );
  });

  it("rejects an unknown labeler, mode or a concurrency below 1", () => {
    expect(() => parseArgs(["--labeler", "gpt"])).toThrow(/--labeler/);
    expect(() => parseArgs(["--labeler", "deepseek", "--mode", "live"])).toThrow(/--mode/);
    expect(() => parseArgs(["--labeler", "deepseek", "--concurrency", "0"])).toThrow(
      /--concurrency/,
    );
  });

  it("refuses a dry-run labeler in record mode: it would write seeded noise as ground truth", () => {
    expect(() => parseArgs(["--labeler", "dry-run", "--mode", "record"])).toThrow(
      /dry-run labeler/,
    );
  });
});

describe("applyOracleLabelToLine", () => {
  const LINE = JSON.stringify({
    id: "f1",
    label: { real: true, source: "line-overlap", overlap_lines: 2, fix_changed_lines: 3 },
    future_field: "kept",
  });

  const RESULT: OracleLabelResult = {
    findingId: "f1",
    verdict: "noise",
    labelerModel: "deepseek-v4-pro",
    fixMatch: { verdict: "not-this", confidence: 0.7, reason: "the fix renamed a variable" },
    claimVerification: { verdict: "absent", confidence: 0.6, reason: "the guard is already there" },
    costUsd: 0.002,
    latencyMs: 4000,
  };

  it("adds label.oracle without touching the line-overlap label", () => {
    const parsed = JSON.parse(applyOracleLabelToLine(LINE, RESULT));
    expect(parsed.label.real).toBe(true);
    expect(parsed.label.source).toBe("line-overlap");
    expect(parsed.label.overlap_lines).toBe(2);
    expect(parsed.label.oracle).toEqual({
      verdict: "noise",
      source: "fix-oracle",
      labeler_model: "deepseek-v4-pro",
      fix_match: { verdict: "not-this", confidence: 0.7, reason: "the fix renamed a variable" },
      claim_verification: {
        verdict: "absent",
        confidence: 0.6,
        reason: "the guard is already there",
      },
    });
  });

  it("preserves every other field on the record, including ones this code does not know about", () => {
    const parsed = JSON.parse(applyOracleLabelToLine(LINE, RESULT));
    expect(parsed.future_field).toBe("kept");
    expect(parsed.id).toBe("f1");
  });

  it("returns the line unchanged when there is no result for it", () => {
    expect(applyOracleLabelToLine(LINE, undefined)).toBe(LINE);
  });
});

describe("parseArgs dataset selection", () => {
  it("defaults --hunks and --evidence to the originals", () => {
    const options = parseArgs(["--labeler", "deepseek"]);
    expect(options.hunksPath).toMatch(/datasets\/hunks\.jsonl$/);
    expect(options.evidencePath).toMatch(/datasets\/hunk-evidence\.jsonl$/);
  });

  it("parses --hunks and --evidence for the reversed dataset", () => {
    const options = parseArgs([
      "--labeler",
      "claude-cli",
      "--hunks",
      "datasets/hunks-reversed.jsonl",
      "--evidence",
      "/tmp/evidence.jsonl",
    ]);
    expect(options.hunksPath).toBe("datasets/hunks-reversed.jsonl");
    expect(options.evidencePath).toBe("/tmp/evidence.jsonl");
  });

  it("accepts the claude-cli labeler", () => {
    expect(parseArgs(["--labeler", "claude-cli", "--mode", "record"]).labeler).toBe("claude-cli");
  });

  it("throws when --hunks or --evidence is given no value", () => {
    expect(() => parseArgs(["--labeler", "deepseek", "--hunks"])).toThrow(/--hunks/);
    expect(() => parseArgs(["--labeler", "deepseek", "--evidence"])).toThrow(/--evidence/);
  });
});

describe("evidenceKeyForHunk", () => {
  it("uses the hunk's own id when it was not reversed", () => {
    expect(evidenceKeyForHunk({ id: "zod-abc-1" })).toBe("zod-abc-1");
  });

  it("resolves a reversed hunk back to the id the evidence file is keyed by", () => {
    expect(evidenceKeyForHunk({ id: "zod-abc-1-rev", reversedFrom: "zod-abc-1" })).toBe(
      "zod-abc-1",
    );
  });
});
