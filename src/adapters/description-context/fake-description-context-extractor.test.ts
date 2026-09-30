import { describe, expect, it } from "vitest";
import { SAMPLE_DESCRIPTION_CONTEXT_INPUT as SAMPLE_INPUT } from "./description-context-test-fixtures.js";
import {
  UnscriptedDescriptionContextError,
  createFakeDescriptionContextExtractor,
  fakeDescriptionContextOutput,
} from "./fake-description-context-extractor.js";

describe("createFakeDescriptionContextExtractor", () => {
  it("returns the scripted output for a PR id", async () => {
    const output = fakeDescriptionContextOutput({ decisions: ["cache 5 min"] });
    const extractor = createFakeDescriptionContextExtractor({ [SAMPLE_INPUT.prId]: output });
    await expect(extractor.extract(SAMPLE_INPUT)).resolves.toBe(output);
  });

  it("rejects with a scripted error", async () => {
    const extractor = createFakeDescriptionContextExtractor({
      [SAMPLE_INPUT.prId]: new Error("401"),
    });
    await expect(extractor.extract(SAMPLE_INPUT)).rejects.toThrow("401");
  });

  it("computes the output from the input when scripted with a function, and records every call", async () => {
    const extractor = createFakeDescriptionContextExtractor((input) =>
      fakeDescriptionContextOutput({ references: [input.title] }),
    );
    const output = await extractor.extract(SAMPLE_INPUT);
    expect(output.context.references).toEqual([SAMPLE_INPUT.title]);
    expect(extractor.calls).toEqual([SAMPLE_INPUT]);
  });

  it("throws on an unscripted PR id instead of inventing context", async () => {
    await expect(createFakeDescriptionContextExtractor({}).extract(SAMPLE_INPUT)).rejects.toThrow(
      UnscriptedDescriptionContextError,
    );
  });

  it("builds zero-cost outputs with empty lists by default, overridable", () => {
    const output = fakeDescriptionContextOutput({}, ["LGTM"], { nominalCostUsd: 0.5 });
    expect(output.context).toEqual({
      decisions: [],
      intendedBehaviorChanges: [],
      outOfScope: [],
      constraints: [],
      references: [],
    });
    expect(output.discarded).toEqual(["LGTM"]);
    expect(output.model).toBe("fake-description-context");
    expect(output.nominalCostUsd).toBe(0.5);
  });
});
