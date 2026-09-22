import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JevestConfigError,
  loadJevestConfig,
  loadJevestConfigFromString,
} from "./jevest-config.js";

const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, "../../../config/jevest.example.yml");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevest-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<string> {
  const filePath = join(dir, ".jevest.yml");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

const VALID_YAML = `
reviewer:
  provider: anthropic
  model: claude-sonnet-5
thresholds:
  triage:
    low:
      auto_min: 0.9
      confirm_min: 0.6
  merge_gate:
    low:
      auto_min: 0.95
      confirm_min: 0.7
budgetUsd: 5
maxHunks: 50
`;

describe("loadJevestConfig", () => {
  it("parses a valid config with all fields", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);

    expect(config.reviewer).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(config.budgetUsd).toBe(5);
    expect(config.maxHunks).toBe(50);
    expect(config.thresholds.triage!.low).toEqual({ autoMin: 0.9, confirmMin: 0.6 });
    expect(config.thresholds.merge_gate!.low).toEqual({ autoMin: 0.95, confirmMin: 0.7 });
  });

  it("defaults sizeThresholds to smallMaxChangedLines=50, mediumMaxChangedLines=300 when omitted", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);
    expect(config.sizeThresholds).toEqual({ smallMaxChangedLines: 50, mediumMaxChangedLines: 300 });
  });

  it("accepts an explicit sizeThresholds", async () => {
    const filePath = await writeConfig(
      `${VALID_YAML}\nsizeThresholds:\n  smallMaxChangedLines: 20\n  mediumMaxChangedLines: 100\n`,
    );
    const config = await loadJevestConfig(filePath);
    expect(config.sizeThresholds).toEqual({ smallMaxChangedLines: 20, mediumMaxChangedLines: 100 });
  });

  it("defaults skipChangeKinds to ['rename-or-format'] when omitted", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);
    expect(config.skipChangeKinds).toEqual(["rename-or-format"]);
  });

  it("defaults failClosed to true when omitted", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);
    expect(config.failClosed).toBe(true);
  });

  it("accepts an explicit skipChangeKinds and failClosed", async () => {
    const filePath = await writeConfig(`${VALID_YAML}\nskipChangeKinds: []\nfailClosed: false\n`);
    const config = await loadJevestConfig(filePath);
    expect(config.skipChangeKinds).toEqual([]);
    expect(config.failClosed).toBe(false);
  });

  it("defaults publish.inlineComments to true when omitted", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);
    expect(config.publish).toEqual({ inlineComments: true });
  });

  it("accepts an explicit publish.inlineComments: false", async () => {
    const filePath = await writeConfig(`${VALID_YAML}\npublish:\n  inlineComments: false\n`);
    const config = await loadJevestConfig(filePath);
    expect(config.publish).toEqual({ inlineComments: false });
  });

  it("accepts reviewer.provider 'none' without requiring a model (Jev-only mode)", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: none\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer.provider).toBe("none");
  });

  it("inherits the default model when reviewer.model is omitted for anthropic/openai (partial override)", async () => {
    const filePath = await writeConfig("reviewer:\n  provider: anthropic\nbudgetUsd: 1\n");
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("still throws when reviewer.model is explicitly empty for a non-none provider", async () => {
    const filePath = await writeConfig(
      'reviewer:\n  provider: anthropic\n  model: ""\nbudgetUsd: 1\n',
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
  });

  it("accepts the openai provider", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: openai\n  model: gpt-5.1\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer.provider).toBe("openai");
  });

  it("accepts the deepseek provider", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: deepseek\n  model: deepseek-v4-pro\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("accepts the claude-cli provider (Claude subscription via OAuth token)", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: claude-cli\n  model: claude-opus-5\nbudgetUsd: 1\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer).toEqual({ provider: "claude-cli", model: "claude-opus-5" });
  });

  it("throws a clear error for an unknown provider", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: cohere\n  model: x\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
    await expect(loadJevestConfig(filePath)).rejects.toThrow(/provider/i);
  });

  it("omitting budgetUsd inherits the default from config/jevest.example.yml (partial override)", async () => {
    const filePath = await writeConfig("reviewer:\n  provider: anthropic\n  model: x\n");
    const config = await loadJevestConfig(filePath);
    expect(config.budgetUsd).toBe(5);
  });

  it("throws when budgetUsd is not positive", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: anthropic\n  model: x\nthresholds: {}\nbudgetUsd: 0\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
  });

  describe("spendCap", () => {
    it("defaults to usd 50 / month / warnAtUsd 40 from config/jevest.example.yml", async () => {
      const filePath = await writeConfig("reviewer:\n  provider: anthropic\n  model: x\n");
      const config = await loadJevestConfig(filePath);
      expect(config.spendCap).toEqual({ usd: 50, period: "month", warnAtUsd: 40 });
    });

    it("deep-merges a partial spendCap override (only usd) onto the defaults", async () => {
      const filePath = await writeConfig("spendCap:\n  usd: 100\n");
      const config = await loadJevestConfig(filePath);
      expect(config.spendCap).toEqual({ usd: 100, period: "month", warnAtUsd: 40 });
    });

    it('accepts period "total"', async () => {
      const filePath = await writeConfig("spendCap:\n  period: total\n");
      const config = await loadJevestConfig(filePath);
      expect(config.spendCap.period).toBe("total");
    });

    it("throws when warnAtUsd is not below usd", async () => {
      const filePath = await writeConfig("spendCap:\n  usd: 10\n  warnAtUsd: 10\n");
      await expect(loadJevestConfig(filePath)).rejects.toThrow(/warnAtUsd/);
    });

    it("throws when usd is not positive", async () => {
      const filePath = await writeConfig("spendCap:\n  usd: 0\n  warnAtUsd: -1\n");
      await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
    });

    it("throws on an unknown period", async () => {
      const filePath = await writeConfig("spendCap:\n  period: week\n");
      await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
    });
  });

  it("throws when a threshold's confirm_min exceeds auto_min", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: anthropic\n  model: x\n" +
        "thresholds:\n  triage:\n    low:\n      auto_min: 0.5\n      confirm_min: 0.9\n" +
        "budgetUsd: 1\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
  });

  it("falls back to the built-in defaults (config/jevest.example.yml) when the file does not exist, without throwing", async () => {
    const fromMissing = await loadJevestConfig(join(dir, "missing.yml"));
    const fromExample = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
    expect(fromMissing).toEqual(fromExample);
    // Sanity-check a few concrete values so this test still fails loudly if
    // the example file's shape ever drifts silently.
    expect(fromMissing.reviewer).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(fromMissing.budgetUsd).toBe(5);
    expect(fromMissing.thresholds.hunk_profile!.medium).toEqual({ autoMin: 0.9, confirmMin: 0.65 });
  });

  it("still throws for a non-ENOENT read error (e.g. the path is a directory)", async () => {
    await expect(loadJevestConfig(dir)).rejects.toThrow();
  });

  it("throws when the YAML does not parse to an object", async () => {
    const filePath = await writeConfig("- a\n- b\n");
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
  });

  describe("partial override (deep merge over config/jevest.example.yml)", () => {
    it("merges a partial file over the defaults, keeping every unspecified field", async () => {
      const filePath = await writeConfig("budgetUsd: 1\n");
      const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
      const config = await loadJevestConfig(filePath);

      expect(config.budgetUsd).toBe(1);
      expect(config.reviewer).toEqual(defaults.reviewer);
      expect(config.maxHunks).toBe(defaults.maxHunks);
      expect(config.thresholds).toEqual(defaults.thresholds);
      expect(config.sizeThresholds).toEqual(defaults.sizeThresholds);
      expect(config.skipChangeKinds).toEqual(defaults.skipChangeKinds);
      expect(config.failClosed).toBe(defaults.failClosed);
      expect(config.publish).toEqual(defaults.publish);
      expect(config.findingFilter).toEqual(defaults.findingFilter);
    });

    it("overriding one nested threshold leaves every sibling stage/risk at its default value", async () => {
      const filePath = await writeConfig(
        "thresholds:\n  triage:\n    low:\n      auto_min: 0.99\n      confirm_min: 0.95\n",
      );
      const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
      const config = await loadJevestConfig(filePath);

      expect(config.thresholds.triage!.low).toEqual({ autoMin: 0.99, confirmMin: 0.95 });
      // Every other risk level in "triage", and every other stage entirely,
      // is untouched by the override.
      expect(config.thresholds.triage!.medium).toEqual(defaults.thresholds.triage!.medium);
      expect(config.thresholds.triage!.high).toEqual(defaults.thresholds.triage!.high);
      expect(config.thresholds.hunk_profile).toEqual(defaults.thresholds.hunk_profile);
      expect(config.thresholds.finding_filter).toEqual(defaults.thresholds.finding_filter);
      expect(config.thresholds.merge_gate).toEqual(defaults.thresholds.merge_gate);
    });

    it("replaces an array wholesale rather than merging it (skipChangeKinds)", async () => {
      const filePath = await writeConfig("skipChangeKinds:\n  - delete\n");
      const config = await loadJevestConfig(filePath);
      // Not ["rename-or-format", "delete"] — arrays are replaced, not concatenated.
      expect(config.skipChangeKinds).toEqual(["delete"]);
    });

    it("throws loudly, naming the key, for an unknown top-level config key (typo protection)", async () => {
      const filePath = await writeConfig("budgetUsdd: 1\n");
      await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
      await expect(loadJevestConfig(filePath)).rejects.toThrow(/budgetUsdd/);
    });

    it("treats an empty .jevest.yml as equivalent to the full defaults", async () => {
      const filePath = await writeConfig("");
      const config = await loadJevestConfig(filePath);
      const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
      expect(config).toEqual(defaults);
    });

    it("loads the exact reported partial config (provider none + inlineComments false + budgetUsd + failClosed), no thresholds/maxHunks required", async () => {
      const filePath = await writeConfig(
        "reviewer:\n  provider: none\npublish:\n  inlineComments: false\nbudgetUsd: 1\nfailClosed: true\n",
      );
      const config = await loadJevestConfig(filePath);
      const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);

      expect(config.reviewer.provider).toBe("none");
      expect(config.publish).toEqual({ inlineComments: false });
      expect(config.budgetUsd).toBe(1);
      expect(config.failClosed).toBe(true);
      // Untouched fields fall back to the defaults.
      expect(config.maxHunks).toBe(defaults.maxHunks);
      expect(config.thresholds).toEqual(defaults.thresholds);
    });
  });
});

describe("loadJevestConfigFromString", () => {
  it("parses a valid config from a YAML string, same as loadJevestConfig from a file", async () => {
    const fromString = await loadJevestConfigFromString(VALID_YAML, "owner/repo@sha:.jevest.yml");
    const filePath = await writeConfig(VALID_YAML);
    const fromFile = await loadJevestConfig(filePath);

    expect(fromString).toEqual(fromFile);
  });

  it("treats an empty string as equivalent to the full defaults", async () => {
    const config = await loadJevestConfigFromString("", "owner/repo@sha:.jevest.yml");
    const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
    expect(config).toEqual(defaults);
  });

  it("deep-merges a partial override, same rules as loadJevestConfig", async () => {
    const config = await loadJevestConfigFromString("budgetUsd: 1\n", "owner/repo@sha:.jevest.yml");
    const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);

    expect(config.budgetUsd).toBe(1);
    expect(config.thresholds).toEqual(defaults.thresholds);
  });

  it("throws JevestConfigError naming the given label on invalid YAML", async () => {
    await expect(
      loadJevestConfigFromString("reviewer: [oops\n", "owner/repo@sha:.jevest.yml"),
    ).rejects.toThrow(JevestConfigError);
    await expect(
      loadJevestConfigFromString("reviewer: [oops\n", "owner/repo@sha:.jevest.yml"),
    ).rejects.toThrow(/owner\/repo@sha:\.jevest\.yml/);
  });

  it("throws loudly, naming the key, for an unknown top-level config key", async () => {
    await expect(
      loadJevestConfigFromString("budgetUsdd: 1\n", "owner/repo@sha:.jevest.yml"),
    ).rejects.toThrow(/budgetUsdd/);
  });

  it('defaults the label to "<config>" when omitted', async () => {
    await expect(loadJevestConfigFromString("reviewer: [oops\n")).rejects.toThrow(/<config>/);
  });
});

describe("findingFilter config (stage 4 mode)", () => {
  it('defaults findingFilter.mode to "annotate" when omitted', async () => {
    const config = await loadJevestConfigFromString("", "<config>");
    expect(config.findingFilter).toEqual({ mode: "annotate" });
  });

  it('accepts an explicit findingFilter.mode: "discard"', async () => {
    const config = await loadJevestConfigFromString(
      "findingFilter:\n  mode: discard\n",
      "<config>",
    );
    expect(config.findingFilter).toEqual({ mode: "discard" });
  });

  it("rejects an unknown findingFilter.mode", async () => {
    await expect(
      loadJevestConfigFromString("findingFilter:\n  mode: skip\n", "<config>"),
    ).rejects.toThrow(JevestConfigError);
  });

  it("leaves findingFilter untouched (still the default) when a partial file overrides an unrelated key", async () => {
    const filePath = await writeConfig("budgetUsd: 1\n");
    const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
    const config = await loadJevestConfig(filePath);
    expect(config.findingFilter).toEqual(defaults.findingFilter);
    expect(config.findingFilter).toEqual({ mode: "annotate" });
  });
});

describe("triage config (product context + change summary)", () => {
  it("defaults triage.productContextPath to .jevest/context.yml and changeSummary to auto", async () => {
    const config = await loadJevestConfigFromString("", "<config>");
    expect(config.triage).toEqual({
      productContextPath: ".jevest/context.yml",
      changeSummary: "auto",
    });
  });

  it("accepts an explicit triage block, deep-merged key by key", async () => {
    const config = await loadJevestConfigFromString(
      "triage:\n  changeSummary: never\n",
      "<config>",
    );
    expect(config.triage).toEqual({
      productContextPath: ".jevest/context.yml",
      changeSummary: "never",
    });
  });

  it("accepts changeSummary: always together with an LLM reviewer provider", async () => {
    const config = await loadJevestConfigFromString(
      "triage:\n  changeSummary: always\n  productContextPath: docs/context.yml\n",
      "<config>",
    );
    expect(config.triage).toEqual({
      productContextPath: "docs/context.yml",
      changeSummary: "always",
    });
  });

  it("rejects changeSummary: always when reviewer.provider is none (nothing could write the summary)", async () => {
    await expect(
      loadJevestConfigFromString(
        "reviewer:\n  provider: none\ntriage:\n  changeSummary: always\n",
        "<config>",
      ),
    ).rejects.toThrow(/changeSummary.*always.*reviewer\.provider/);
  });

  it("rejects an unknown changeSummary mode", async () => {
    await expect(
      loadJevestConfigFromString("triage:\n  changeSummary: sometimes\n", "<config>"),
    ).rejects.toThrow(JevestConfigError);
  });

  it("still works for the self-review config (provider none, no triage block): summary auto resolves to none needed", async () => {
    const config = await loadJevestConfigFromString(
      "reviewer:\n  provider: none\npublish:\n  inlineComments: false\nbudgetUsd: 1\n",
      "<config>",
    );
    expect(config.triage.changeSummary).toBe("auto");
    expect(config.reviewer.provider).toBe("none");
  });
});
