import { describe, expect, it } from "vitest";
import { groundTruthFromLabel, parseArgs } from "./run.js";

describe("parseArgs", () => {
  it("defaults to no judge, judge replay mode and judge concurrency 2", () => {
    const options = parseArgs([]);
    expect(options.judge).toBe("none");
    expect(options.judgeMode).toBe("replay");
    expect(options.judgeConcurrency).toBe(2);
    expect(options.mode).toBeNull();
    expect(options.batchSize).toBe(1);
  });

  it("parses --judge claude-cli --judge-mode record --judge-concurrency 3", () => {
    const options = parseArgs([
      "--judge",
      "claude-cli",
      "--judge-mode",
      "record",
      "--judge-concurrency",
      "3",
    ]);
    expect(options.judge).toBe("claude-cli");
    expect(options.judgeMode).toBe("record");
    expect(options.judgeConcurrency).toBe(3);
  });

  it("accepts --judge deepseek", () => {
    expect(parseArgs(["--judge", "deepseek", "--judge-mode", "record"]).judge).toBe("deepseek");
  });

  it("accepts --judge dry-run and --mode dry-run together", () => {
    const options = parseArgs(["--mode", "dry-run", "--judge", "dry-run"]);
    expect(options.mode).toBe("dry-run");
    expect(options.judge).toBe("dry-run");
  });

  it("rejects an unknown judge, judge mode or a judge concurrency below 1", () => {
    expect(() => parseArgs(["--judge", "gpt"])).toThrow(/--judge/);
    expect(() => parseArgs(["--judge-mode", "live"])).toThrow(/--judge-mode/);
    expect(() => parseArgs(["--judge-concurrency", "0"])).toThrow(/--judge-concurrency/);
  });

  it("still parses --findings, --batch-size and --mode", () => {
    const options = parseArgs(["--findings", "x.jsonl", "--batch-size", "2", "--mode", "replay"]);
    expect(options.findingsPath).toBe("x.jsonl");
    expect(options.batchSize).toBe(2);
    expect(options.mode).toBe("replay");
  });
});

describe("parseArgs --label", () => {
  it("defaults to line-overlap so the committed H1/H6/H3 numbers stay reproducible", () => {
    expect(parseArgs([]).label).toBe("line-overlap");
  });

  it("accepts --label oracle", () => {
    expect(parseArgs(["--label", "oracle"]).label).toBe("oracle");
  });

  it("rejects an unknown label", () => {
    expect(() => parseArgs(["--label", "human"])).toThrow(/--label/);
  });
});

describe("groundTruthFromLabel", () => {
  const base = {
    id: "f1",
    hunkId: "h1",
    datasetVersion: 2,
    reviewer: { provider: "claude-cli" as const, model: "m" },
    file: "a.ts",
    lineStart: 1,
    lineEnd: 1,
    claim: "c",
    rationale: "r",
    suggestedSeverity: "minor" as const,
    needsManualReview: true,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    latencyMs: 0,
  };

  function withOracle(id: string, real: boolean, verdict: "real" | "noise" | "unknown") {
    return {
      ...base,
      id,
      label: {
        real,
        source: "line-overlap",
        overlapLines: 0,
        fixChangedLines: 0,
        oracle: {
          verdict,
          source: "fix-oracle" as const,
          labelerModel: "deepseek-v4-pro",
          fixMatch: { verdict: "real" as const, confidence: 0.5, reason: "x" },
          claimVerification: { verdict: "present" as const, confidence: 0.5, reason: "y" },
        },
      },
    };
  }

  it("uses label.real under line-overlap and ignores the oracle entirely", () => {
    const { groundTruth, counts } = groundTruthFromLabel(
      [withOracle("f1", true, "noise"), withOracle("f2", false, "real")],
      "line-overlap",
    );
    expect(groundTruth).toEqual({ f1: true, f2: false });
    expect(counts).toEqual({ real: 1, noise: 1, unknown: 0 });
  });

  it("uses label.oracle.verdict under oracle and drops unknown from the ground truth", () => {
    const { groundTruth, counts } = groundTruthFromLabel(
      [
        withOracle("f1", false, "real"),
        withOracle("f2", true, "noise"),
        withOracle("f3", true, "unknown"),
      ],
      "oracle",
    );
    expect(groundTruth).toEqual({ f1: true, f2: false });
    expect(counts).toEqual({ real: 1, noise: 1, unknown: 1 });
  });

  it("counts a record the labeler could not label (no label.oracle) as unknown when the file is an oracle file", () => {
    const withoutOracle = {
      ...base,
      id: "f9",
      label: { real: true, source: "line-overlap", overlapLines: 0, fixChangedLines: 0 },
    };
    const { groundTruth, counts } = groundTruthFromLabel(
      [withOracle("f1", false, "real"), withoutOracle],
      "oracle",
    );
    expect(groundTruth).toEqual({ f1: true });
    expect(counts).toEqual({ real: 1, noise: 0, unknown: 1 });
  });

  it("fails with a clear message when no record at all has an oracle label (wrong file)", () => {
    const withoutOracle = {
      ...base,
      label: { real: true, source: "line-overlap", overlapLines: 0, fixChangedLines: 0 },
    };
    expect(() => groundTruthFromLabel([withoutOracle], "oracle")).toThrow(/pnpm findings:label/);
  });
});

describe("parseArgs --hunks", () => {
  it("defaults to datasets/hunks.jsonl", () => {
    expect(parseArgs([]).hunksPath).toMatch(/datasets\/hunks\.jsonl$/);
  });

  it("parses --hunks so Jev and the judge see the same reversed diffs the reviewer saw", () => {
    expect(parseArgs(["--hunks", "datasets/hunks-reversed.jsonl"]).hunksPath).toBe(
      "datasets/hunks-reversed.jsonl",
    );
  });

  it("throws when --hunks is given no value", () => {
    expect(() => parseArgs(["--hunks"])).toThrow(/--hunks/);
  });
});
