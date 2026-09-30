import { describe, expect, it } from "vitest";
import {
  UnscriptedNarrativeError,
  createFakeNarrator,
  fakeNarrativeOutput,
} from "./fake-narrator.js";
import { SAMPLE_NARRATIVE_INPUT as SAMPLE_INPUT } from "./narrative-test-fixtures.js";

describe("createFakeNarrator", () => {
  it("returns the scripted output for a PR id", async () => {
    const output = fakeNarrativeOutput("Todo bien.");
    const narrator = createFakeNarrator({ [SAMPLE_INPUT.prId]: output });
    await expect(narrator.narrate(SAMPLE_INPUT)).resolves.toBe(output);
  });

  it("rejects with a scripted error", async () => {
    const narrator = createFakeNarrator({ [SAMPLE_INPUT.prId]: new Error("401") });
    await expect(narrator.narrate(SAMPLE_INPUT)).rejects.toThrow("401");
  });

  it("computes the output from the input when scripted with a function, and records every call", async () => {
    const narrator = createFakeNarrator((input) =>
      fakeNarrativeOutput(`${input.findings.length} findings in ${input.language}`),
    );
    const output = await narrator.narrate(SAMPLE_INPUT);
    expect(output.markdown).toBe("2 findings in es");
    expect(narrator.calls).toEqual([SAMPLE_INPUT]);
  });

  it("throws on an unscripted PR id instead of inventing a review", async () => {
    await expect(createFakeNarrator({}).narrate(SAMPLE_INPUT)).rejects.toThrow(
      UnscriptedNarrativeError,
    );
  });

  it("builds outputs with zero-cost defaults that a test can override", () => {
    expect(fakeNarrativeOutput("x")).toMatchObject({
      markdown: "x",
      model: "fake-narrator",
      nominalCostUsd: 0,
    });
    expect(fakeNarrativeOutput("x", { nominalCostUsd: 0.5 }).nominalCostUsd).toBe(0.5);
  });
});
