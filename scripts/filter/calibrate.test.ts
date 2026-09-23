import { describe, expect, it } from "vitest";
import { defaultHunksPathFor, parseArgs, setNameFor } from "./calibrate.js";

describe("parseArgs", () => {
  it("defaults to both oracle sets, each with the hunks the reviewer actually ran against", () => {
    const options = parseArgs([]);
    expect(options.sets).toHaveLength(2);
    expect(options.sets[0]?.findingsPath).toMatch(/findings-reversed-oracle\.jsonl$/);
    expect(options.sets[0]?.hunksPath).toMatch(/hunks-reversed\.jsonl$/);
    expect(options.sets[1]?.findingsPath).toMatch(/findings-thorough-oracle\.jsonl$/);
    expect(options.sets[1]?.hunksPath).toMatch(/hunks\.jsonl$/);
    expect(options.folds).toBe(5);
    expect(options.primarySet).toBeNull();
    expect(options.emitPath).toBeNull();
  });

  it("parses --set <findings>:<hunks> pairs, replacing the defaults", () => {
    const options = parseArgs(["--set", "a/f.jsonl:a/h.jsonl", "--set", "b/f.jsonl:b/h.jsonl"]);
    expect(options.sets).toEqual([
      { name: "f", findingsPath: "a/f.jsonl", hunksPath: "a/h.jsonl" },
      { name: "f-2", findingsPath: "b/f.jsonl", hunksPath: "b/h.jsonl" },
    ]);
  });

  it("parses --findings with its own --hunks", () => {
    const options = parseArgs([
      "--findings",
      "x/findings-thorough-oracle.jsonl",
      "--hunks",
      "x/h.jsonl",
    ]);
    expect(options.sets).toEqual([
      {
        name: "findings-thorough-oracle",
        findingsPath: "x/findings-thorough-oracle.jsonl",
        hunksPath: "x/h.jsonl",
      },
    ]);
  });

  it("falls back to the matching default hunks file when --findings has no --hunks", () => {
    const options = parseArgs(["--findings", "datasets/findings-reversed-oracle.jsonl"]);
    expect(options.sets[0]?.hunksPath).toMatch(/hunks-reversed\.jsonl$/);
  });

  it("attaches each --hunks to the --findings it follows", () => {
    const options = parseArgs([
      "--findings",
      "a.jsonl",
      "--hunks",
      "ah.jsonl",
      "--findings",
      "b.jsonl",
      "--hunks",
      "bh.jsonl",
    ]);
    expect(options.sets.map((s) => s.hunksPath)).toEqual(["ah.jsonl", "bh.jsonl"]);
  });

  it("rejects --hunks before any --findings", () => {
    expect(() => parseArgs(["--hunks", "h.jsonl"])).toThrow(/--hunks/);
  });

  it("rejects a --set without a colon", () => {
    expect(() => parseArgs(["--set", "findings.jsonl"])).toThrow(/--set/);
  });

  it("rejects mixing --set with --findings", () => {
    expect(() => parseArgs(["--set", "a:b", "--findings", "c.jsonl"])).toThrow(/--set/);
  });

  it("parses --folds, --seed, --primary and --emit", () => {
    const options = parseArgs([
      "--folds",
      "10",
      "--seed",
      "1",
      "--primary",
      "findings-reversed-oracle",
      "--emit",
      "config/calibration/is_real_defect.json",
    ]);
    expect(options.folds).toBe(10);
    expect(options.seed).toBe(1);
    expect(options.primarySet).toBe("findings-reversed-oracle");
    expect(options.emitPath).toBe("config/calibration/is_real_defect.json");
  });

  it("rejects fewer than two folds", () => {
    expect(() => parseArgs(["--folds", "1"])).toThrow(/--folds/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--mode", "live"])).toThrow(/--mode/);
  });
});

describe("defaultHunksPathFor", () => {
  it("routes a reversed findings file to the reversed hunks", () => {
    expect(defaultHunksPathFor("datasets/findings-reversed-oracle.jsonl")).toMatch(
      /hunks-reversed\.jsonl$/,
    );
  });

  it("routes anything else to the original hunks", () => {
    expect(defaultHunksPathFor("datasets/findings-thorough-oracle.jsonl")).toMatch(
      /datasets\/hunks\.jsonl$/,
    );
  });
});

describe("setNameFor", () => {
  it("names a set after its findings file stem", () => {
    expect(setNameFor("datasets/findings-reversed-oracle.jsonl", [])).toBe(
      "findings-reversed-oracle",
    );
  });

  it("suffixes a name that is already taken, so two sets never collide", () => {
    expect(setNameFor("other/findings.jsonl", ["findings"])).toBe("findings-2");
    expect(setNameFor("other/findings.jsonl", ["findings", "findings-2"])).toBe("findings-3");
  });
});
