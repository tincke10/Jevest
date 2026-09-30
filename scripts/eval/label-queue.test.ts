import { describe, expect, it } from "vitest";
import { parseLabelQueueArgs } from "./label-queue.js";

describe("parseLabelQueueArgs (scripts/eval/label-queue.ts)", () => {
  it("defaults to the shown view and stdout", () => {
    expect(parseLabelQueueArgs(["--run", "runs/a"])).toEqual({
      run: "runs/a",
      view: "shown",
      outPath: null,
    });
  });

  it("accepts --view all and --out", () => {
    expect(parseLabelQueueArgs(["--run", "r", "--view", "all", "--out", "q.jsonl"])).toEqual({
      run: "r",
      view: "all",
      outPath: "q.jsonl",
    });
  });

  it("requires --run and a valid view", () => {
    expect(() => parseLabelQueueArgs([])).toThrow(/--run/);
    expect(() => parseLabelQueueArgs(["--run", "r", "--view", "low"])).toThrow(/--view/);
  });
});
