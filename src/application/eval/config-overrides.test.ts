import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadJevestConfigFromString } from "../../adapters/config/jevest-config.js";
import { applyConfigOverrides, parseOverride } from "./config-overrides.js";

describe("parseOverride", () => {
  it("splits a dotted key and parses the value as YAML", () => {
    expect(parseOverride("reviewer.model=claude-sonnet-5")).toEqual({
      path: ["reviewer", "model"],
      value: "claude-sonnet-5",
    });
    expect(parseOverride("thresholds.triage.low.autoMin=0.9")).toEqual({
      path: ["thresholds", "triage", "low", "autoMin"],
      value: 0.9,
    });
    expect(parseOverride("reviewer.narrative=false").value).toBe(false);
    expect(parseOverride("skipChangeKinds=[a, b]").value).toEqual(["a", "b"]);
    expect(parseOverride("reviewer.language=a=b").value).toBe("a=b");
  });

  it("rejects a malformed override", () => {
    expect(() => parseOverride("reviewer.model")).toThrow(/key=value/);
    expect(() => parseOverride("=x")).toThrow(/key=value/);
    expect(() => parseOverride("a..b=x")).toThrow(/key=value/);
  });
});

describe("applyConfigOverrides", () => {
  const base = "reviewer:\n  provider: claude-cli\n  model: claude-opus-5\nbudgetUsd: 1\n";

  it("merges an overrides document, then the dotted overrides, over the base YAML", () => {
    const yaml = applyConfigOverrides(base, { reviewer: { narrative: false }, budgetUsd: 2 }, [
      parseOverride("reviewer.model=claude-sonnet-5"),
      parseOverride("budgetUsd=3"),
    ]);
    expect(parse(yaml)).toEqual({
      reviewer: { provider: "claude-cli", model: "claude-sonnet-5", narrative: false },
      budgetUsd: 3,
    });
  });

  it("starts from an empty config when there is no base", () => {
    const yaml = applyConfigOverrides(null, undefined, [parseOverride("reviewer.provider=none")]);
    expect(parse(yaml)).toEqual({ reviewer: { provider: "none" } });
  });

  it("rejects an overrides document that is not a mapping", () => {
    expect(() => applyConfigOverrides(base, [1, 2], [])).toThrow(/mapping/);
  });
});

describe("agentic variants via --override", () => {
  it("switches a claude-cli config to agentic mode with the verifier and its caps", async () => {
    const yaml = applyConfigOverrides(
      "reviewer:\n  provider: claude-cli\n  model: claude-opus-5\nbudgetUsd: 2\n",
      undefined,
      [
        "reviewer.mode=agentic",
        "reviewer.verifier.provider=claude-cli",
        "reviewer.verifier.model=claude-sonnet-5",
        "reviewer.agentic.maxTurns=30",
        "reviewer.agentic.effort=xhigh",
        "reviewer.verifier.effort=low",
        "reviewer.verifier.maxTurns=6",
      ].map(parseOverride),
    );
    const config = await loadJevestConfigFromString(yaml);
    expect(config.reviewer).toMatchObject({
      provider: "claude-cli",
      mode: "agentic",
      verifier: {
        provider: "claude-cli",
        model: "claude-sonnet-5",
        effort: "low",
        maxTurns: 6,
        timeoutMs: 300_000,
      },
      agentic: { maxTurns: 30, timeoutMs: 900_000, effort: "xhigh" },
    });
    expect(config.budgetUsd).toBe(2);
  });
});
