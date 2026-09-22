import { describe, expect, it } from "vitest";
import { parseArgs } from "./generate.js";

describe("parseArgs", () => {
  it("requires --provider", () => {
    expect(() => parseArgs([])).toThrow(/--provider/);
  });

  it("rejects an unknown provider", () => {
    expect(() => parseArgs(["--provider", "cohere"])).toThrow(/--provider/);
  });

  it("parses --provider anthropic with defaults", () => {
    const options = parseArgs(["--provider", "anthropic"]);
    expect(options).toEqual({
      provider: "anthropic",
      limit: null,
      budgetUsd: 5,
      estimate: false,
      out: null,
      record: false,
      seed: 42,
      concurrency: 2,
      prompt: "strict",
      hunks: null,
      fixturesDir: null,
    });
  });

  it("parses --prompt thorough and rejects an unknown prompt mode", () => {
    expect(parseArgs(["--provider", "claude-cli", "--prompt", "thorough"]).prompt).toBe("thorough");
    expect(() => parseArgs(["--provider", "claude-cli", "--prompt", "lenient"])).toThrow(
      /--prompt/,
    );
  });

  it("parses --provider openai", () => {
    expect(parseArgs(["--provider", "openai"]).provider).toBe("openai");
  });

  it("parses --provider deepseek", () => {
    expect(parseArgs(["--provider", "deepseek"]).provider).toBe("deepseek");
  });

  it("parses --provider claude-cli", () => {
    expect(parseArgs(["--provider", "claude-cli"]).provider).toBe("claude-cli");
  });

  it("parses --limit as a non-negative number", () => {
    expect(parseArgs(["--provider", "anthropic", "--limit", "10"]).limit).toBe(10);
  });

  it("rejects a negative --limit", () => {
    expect(() => parseArgs(["--provider", "anthropic", "--limit", "-1"])).toThrow(/--limit/);
  });

  it("parses --budget-usd", () => {
    expect(parseArgs(["--provider", "anthropic", "--budget-usd", "1.5"]).budgetUsd).toBe(1.5);
  });

  it("rejects a non-positive --budget-usd", () => {
    expect(() => parseArgs(["--provider", "anthropic", "--budget-usd", "0"])).toThrow(
      /--budget-usd/,
    );
  });

  it("parses --estimate as a flag", () => {
    expect(parseArgs(["--provider", "anthropic", "--estimate"]).estimate).toBe(true);
  });

  it("parses --out", () => {
    expect(parseArgs(["--provider", "anthropic", "--out", "/tmp/x.jsonl"]).out).toBe(
      "/tmp/x.jsonl",
    );
  });

  it("parses --record as a flag", () => {
    expect(parseArgs(["--provider", "anthropic", "--record"]).record).toBe(true);
  });

  it("parses --seed", () => {
    expect(parseArgs(["--provider", "anthropic", "--seed", "7"]).seed).toBe(7);
  });

  it("parses --concurrency, default 2", () => {
    expect(parseArgs(["--provider", "claude-cli"]).concurrency).toBe(2);
    expect(parseArgs(["--provider", "claude-cli", "--concurrency", "5"]).concurrency).toBe(5);
  });

  it("rejects a --concurrency below 1", () => {
    expect(() => parseArgs(["--provider", "claude-cli", "--concurrency", "0"])).toThrow(
      /--concurrency/,
    );
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--provider", "anthropic", "--bogus"])).toThrow(/--bogus/);
  });

  it("throws when a flag requiring a value is given none", () => {
    expect(() => parseArgs(["--provider"])).toThrow(/--provider/);
  });
});

describe("parseArgs dataset selection", () => {
  it("defaults --hunks to datasets/hunks.jsonl and --fixtures-dir to the prompt mode's dir", () => {
    const options = parseArgs(["--provider", "claude-cli"]);
    expect(options.hunks).toBeNull();
    expect(options.fixturesDir).toBeNull();
  });

  it("parses --hunks and --fixtures-dir", () => {
    const options = parseArgs([
      "--provider",
      "claude-cli",
      "--hunks",
      "datasets/hunks-reversed.jsonl",
      "--fixtures-dir",
      "tests/fixtures/findings-reversed",
    ]);
    expect(options.hunks).toBe("datasets/hunks-reversed.jsonl");
    expect(options.fixturesDir).toBe("tests/fixtures/findings-reversed");
  });

  it("throws when --hunks or --fixtures-dir is given no value", () => {
    expect(() => parseArgs(["--provider", "claude-cli", "--hunks"])).toThrow(/--hunks/);
    expect(() => parseArgs(["--provider", "claude-cli", "--fixtures-dir"])).toThrow(
      /--fixtures-dir/,
    );
  });
});
