import { describe, expect, it } from "vitest";
import { parseArgs } from "./run.js";

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
