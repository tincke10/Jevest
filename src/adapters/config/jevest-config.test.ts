import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
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
      autoMin: 0.9
      confirmMin: 0.6
  mergeGate:
    low:
      autoMin: 0.95
      confirmMin: 0.7
budgetUsd: 5
maxHunks: 50
`;

describe("loadJevestConfig", () => {
  it("parses a valid config with all fields", async () => {
    const filePath = await writeConfig(VALID_YAML);
    const config = await loadJevestConfig(filePath);

    expect(config.reviewer).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      language: "en",
      narrative: true,
      descriptionContext: true,
      mode: "hunks",
      agentic: { maxTurns: 60, timeoutMs: 900_000, effort: "xhigh" },
      verifier: {
        provider: "none",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      },
      hunks: { fullFile: false, impactContext: false, requireEvidence: false },
    });
    expect(config.budgetUsd).toBe(5);
    expect(config.maxHunks).toBe(50);
    expect(config.thresholds.triage!.low).toEqual({ autoMin: 0.9, confirmMin: 0.6 });
    expect(config.thresholds.mergeGate!.low).toEqual({ autoMin: 0.95, confirmMin: 0.7 });
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

  it("inherits the default model when reviewer.model is omitted for anthropic (partial override)", async () => {
    const filePath = await writeConfig("reviewer:\n  provider: anthropic\nbudgetUsd: 1\n");
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      language: "en",
      narrative: true,
      descriptionContext: true,
      mode: "hunks",
      agentic: { maxTurns: 60, timeoutMs: 900_000, effort: "xhigh" },
      verifier: {
        provider: "none",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      },
      hunks: { fullFile: false, impactContext: false, requireEvidence: false },
    });
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
    expect(config.reviewer).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      language: "en",
      narrative: true,
      descriptionContext: true,
      mode: "hunks",
      agentic: { maxTurns: 60, timeoutMs: 900_000, effort: "xhigh" },
      verifier: {
        provider: "none",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      },
      hunks: { fullFile: false, impactContext: false, requireEvidence: false },
    });
  });

  it("accepts the claude-cli provider (Claude subscription via OAuth token), agentic with the verifier by default", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: claude-cli\n  model: claude-opus-5\nbudgetUsd: 1\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer).toEqual({
      provider: "claude-cli",
      model: "claude-opus-5",
      language: "en",
      narrative: true,
      descriptionContext: true,
      mode: "agentic",
      agentic: { maxTurns: 60, timeoutMs: 900_000, effort: "xhigh" },
      verifier: {
        provider: "claude-cli",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      },
      hunks: { fullFile: false, impactContext: false, requireEvidence: false },
    });
  });

  describe("1.0 default rule: mode, model and verifier follow the provider when unset", () => {
    it("claude-cli without mode/model/verifier resolves to the recommended agentic stack", async () => {
      const config = await loadJevestConfigFromString("reviewer:\n  provider: claude-cli\n");
      expect(config.reviewer).toMatchObject({
        provider: "claude-cli",
        model: "claude-opus-5-5",
        mode: "agentic",
        verifier: {
          provider: "claude-cli",
          model: "claude-sonnet-5",
          effort: "medium",
          maxTurns: 12,
          timeoutMs: 300_000,
        },
        agentic: { effort: "xhigh" },
      });
    });

    it("claude-cli with mode: hunks is the 0.1 per-hunk reviewer: claude-sonnet-5, no verifier", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: claude-cli\n  mode: hunks\n",
      );
      expect(config.reviewer).toMatchObject({
        provider: "claude-cli",
        model: "claude-sonnet-5",
        mode: "hunks",
        verifier: { provider: "none" },
      });
    });

    it("any other provider resolves to hunks and no verifier, so naming it never trips the agentic check", async () => {
      for (const yaml of [
        "reviewer:\n  provider: anthropic\n",
        "reviewer:\n  provider: openai\n  model: gpt-5.1\n",
        "reviewer:\n  provider: deepseek\n  model: deepseek-v4-pro\n",
        "reviewer:\n  provider: none\n",
      ]) {
        const config = await loadJevestConfigFromString(yaml);
        expect(config.reviewer.mode).toBe("hunks");
        expect(config.reviewer.verifier.provider).toBe("none");
      }
    });

    it("anthropic without a model keeps the 0.1 default model, claude-sonnet-5", async () => {
      const config = await loadJevestConfigFromString("reviewer:\n  provider: anthropic\n");
      expect(config.reviewer.model).toBe("claude-sonnet-5");
    });

    it("openai and deepseek need an explicit model instead of inheriting a Claude model id", async () => {
      for (const provider of ["openai", "deepseek"]) {
        await expect(
          loadJevestConfigFromString(`reviewer:\n  provider: ${provider}\n`),
        ).rejects.toThrow(
          new RegExp(`reviewer\\.model is required when reviewer\\.provider is .{0,2}${provider}`),
        );
      }
    });

    it("an explicit model, verifier: none or mode always wins over the resolved default", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: claude-cli\n  model: claude-sonnet-5\n  verifier:\n    provider: none\n",
      );
      expect(config.reviewer).toMatchObject({
        model: "claude-sonnet-5",
        mode: "agentic",
        verifier: { provider: "none" },
      });
    });
  });

  describe("reviewer.hunks: fullFile / impactContext / requireEvidence (code context, opt-in)", () => {
    it("defaults all three to false, whatever the provider", async () => {
      for (const yaml of [
        "reviewer:\n  provider: openai\n  model: m\n",
        "reviewer:\n  provider: none\n",
      ]) {
        const config = await loadJevestConfigFromString(yaml);
        expect(config.reviewer.hunks).toEqual({
          fullFile: false,
          impactContext: false,
          requireEvidence: false,
        });
      }
    });

    it("turns each one on explicitly, and a partial block keeps the others at their default", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: claude-cli\n  model: m\n  hunks:\n    fullFile: true\n    impactContext: true\n    requireEvidence: true\n",
      );
      expect(config.reviewer.hunks).toEqual({
        fullFile: true,
        impactContext: true,
        requireEvidence: true,
      });
      const partial = await loadJevestConfigFromString(
        "reviewer:\n  provider: openai\n  model: m\n  hunks:\n    requireEvidence: true\n",
      );
      expect(partial.reviewer.hunks).toEqual({
        fullFile: false,
        impactContext: false,
        requireEvidence: true,
      });
    });

    it("rejects a non-boolean", async () => {
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: openai\n  model: m\n  hunks:\n    fullFile: yes please\n",
        ),
      ).rejects.toThrow(JevestConfigError);
    });
  });

  describe("reviewer.mode (hunks | agentic) and reviewer.verifier", () => {
    it("defaults to the per-hunk mode, no verifier, and the documented agentic and verifier caps", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: openai\n  model: m\n",
      );
      expect(config.reviewer.mode).toBe("hunks");
      expect(config.reviewer.verifier).toEqual({
        provider: "none",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      });
      expect(config.reviewer.agentic).toEqual({
        maxTurns: 60,
        timeoutMs: 900_000,
        effort: "xhigh",
      });
    });

    it("accepts every effort level for the agent and the verifier", async () => {
      for (const level of ["low", "medium", "high", "xhigh", "max"]) {
        const config = await loadJevestConfigFromString(
          `reviewer:\n  provider: claude-cli\n  model: m\n  mode: agentic\n  verifier:\n    effort: ${level}\n  agentic:\n    effort: ${level}\n`,
        );
        expect(config.reviewer.agentic.effort).toBe(level);
        expect(config.reviewer.verifier.effort).toBe(level);
      }
    });

    it("rejects an unknown effort level for the agent and the verifier", async () => {
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  model: m\n  mode: agentic\n  agentic:\n    effort: ultra\n",
        ),
      ).rejects.toThrow(JevestConfigError);
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  model: m\n  mode: agentic\n  verifier:\n    effort: ultra\n",
        ),
      ).rejects.toThrow(JevestConfigError);
    });

    it("accepts agentic mode with the claude-cli provider, a verifier and custom caps", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: claude-cli\n  model: m\n  mode: agentic\n  verifier:\n    provider: claude-cli\n    model: v\n    maxTurns: 6\n    timeoutMs: 1000\n  agentic:\n    maxTurns: 25\n",
      );
      expect(config.reviewer.mode).toBe("agentic");
      expect(config.reviewer.verifier).toEqual({
        provider: "claude-cli",
        model: "v",
        effort: "medium",
        maxTurns: 6,
        timeoutMs: 1000,
      });
      expect(config.reviewer.agentic.maxTurns).toBe(25);
      expect(config.reviewer.agentic.timeoutMs).toBe(900_000);
    });

    it("tuning the verifier without naming its provider keeps the provider-dependent default", async () => {
      const agentic = await loadJevestConfigFromString(
        "reviewer:\n  provider: claude-cli\n  verifier:\n    model: claude-opus-5-5\n",
      );
      expect(agentic.reviewer.verifier.provider).toBe("claude-cli");
      expect(agentic.reviewer.verifier.model).toBe("claude-opus-5-5");
      const hunks = await loadJevestConfigFromString(
        "reviewer:\n  provider: anthropic\n  verifier:\n    effort: low\n",
      );
      expect(hunks.reviewer.verifier.provider).toBe("none");
    });

    it("rejects agentic mode with any other provider, naming the requirement", async () => {
      for (const provider of ["anthropic", "openai", "deepseek", "none"]) {
        await expect(
          loadJevestConfigFromString(
            `reviewer:\n  provider: ${provider}\n  model: m\n  mode: agentic\n`,
          ),
        ).rejects.toThrow(/agentic mode currently requires reviewer\.provider: claude-cli/);
      }
    });

    it("rejects a verifier outside agentic mode instead of silently ignoring it", async () => {
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  model: m\n  mode: hunks\n  verifier:\n    provider: claude-cli\n",
        ),
      ).rejects.toThrow(/reviewer\.verifier\.provider needs reviewer\.mode: agentic/);
    });

    it("rejects an unknown mode, an unknown verifier provider and a non-positive turn cap", async () => {
      await expect(
        loadJevestConfigFromString("reviewer:\n  provider: claude-cli\n  model: m\n  mode: repo\n"),
      ).rejects.toThrow(JevestConfigError);
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  verifier:\n    provider: anthropic\n",
        ),
      ).rejects.toThrow(JevestConfigError);
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  model: m\n  mode: agentic\n  agentic:\n    maxTurns: 0\n",
        ),
      ).rejects.toThrow(JevestConfigError);
      await expect(
        loadJevestConfigFromString(
          "reviewer:\n  provider: claude-cli\n  verifier:\n    maxTurns: 0\n",
        ),
      ).rejects.toThrow(JevestConfigError);
    });
  });

  describe("reviewer.language and reviewer.narrative (colleague review)", () => {
    it('defaults language to "en" and narrative to true when an LLM provider is configured', async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: openai\n  model: m\n",
      );
      expect(config.reviewer.language).toBe("en");
      expect(config.reviewer.narrative).toBe(true);
    });

    it("defaults narrative to false in Jev-only mode (provider none): there is no LLM to write it", async () => {
      const config = await loadJevestConfigFromString("reviewer:\n  provider: none\n");
      expect(config.reviewer.narrative).toBe(false);
    });

    it("accepts an explicit language and narrative: false", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: anthropic\n  language: es-AR\n  narrative: false\n",
      );
      expect(config.reviewer.language).toBe("es-AR");
      expect(config.reviewer.narrative).toBe(false);
    });

    it("throws when narrative is explicitly true with provider none", async () => {
      await expect(
        loadJevestConfigFromString("reviewer:\n  provider: none\n  narrative: true\n"),
      ).rejects.toThrow(/reviewer\.narrative/);
    });

    it("defaults descriptionContext to true with an LLM provider and to false with none", async () => {
      expect(
        (await loadJevestConfigFromString("reviewer:\n  provider: openai\n  model: m\n")).reviewer
          .descriptionContext,
      ).toBe(true);
      expect(
        (await loadJevestConfigFromString("reviewer:\n  provider: none\n")).reviewer
          .descriptionContext,
      ).toBe(false);
    });

    it("accepts descriptionContext: false", async () => {
      const config = await loadJevestConfigFromString(
        "reviewer:\n  provider: anthropic\n  descriptionContext: false\n",
      );
      expect(config.reviewer.descriptionContext).toBe(false);
    });

    it("throws when descriptionContext is explicitly true with provider none", async () => {
      await expect(
        loadJevestConfigFromString("reviewer:\n  provider: none\n  descriptionContext: true\n"),
      ).rejects.toThrow(/reviewer\.descriptionContext/);
    });

    it("throws on an empty language", async () => {
      await expect(
        loadJevestConfigFromString('reviewer:\n  provider: anthropic\n  language: ""\n'),
      ).rejects.toThrow(JevestConfigError);
    });
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

  it("throws when a threshold's confirmMin exceeds autoMin", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: anthropic\n  model: x\n" +
        "thresholds:\n  triage:\n    low:\n      autoMin: 0.5\n      confirmMin: 0.9\n" +
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
    expect(fromMissing.reviewer).toEqual({
      provider: "claude-cli",
      model: "claude-opus-5-5",
      language: "en",
      narrative: true,
      descriptionContext: true,
      mode: "agentic",
      agentic: { maxTurns: 60, timeoutMs: 900_000, effort: "xhigh" },
      verifier: {
        provider: "claude-cli",
        model: "claude-sonnet-5",
        effort: "medium",
        maxTurns: 12,
        timeoutMs: 300_000,
      },
      hunks: { fullFile: false, impactContext: false, requireEvidence: false },
    });
    expect(fromMissing.budgetUsd).toBe(5);
    expect(fromMissing.thresholds.hunkProfile!.medium).toEqual({ autoMin: 0.9, confirmMin: 0.65 });
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
        "thresholds:\n  triage:\n    low:\n      autoMin: 0.99\n      confirmMin: 0.95\n",
      );
      const defaults = await loadJevestConfig(EXAMPLE_CONFIG_PATH);
      const config = await loadJevestConfig(filePath);

      expect(config.thresholds.triage!.low).toEqual({ autoMin: 0.99, confirmMin: 0.95 });
      // Every other risk level in "triage", and every other stage entirely,
      // is untouched by the override.
      expect(config.thresholds.triage!.medium).toEqual(defaults.thresholds.triage!.medium);
      expect(config.thresholds.triage!.high).toEqual(defaults.thresholds.triage!.high);
      expect(config.thresholds.hunkProfile).toEqual(defaults.thresholds.hunkProfile);
      expect(config.thresholds.findingFilter).toEqual(defaults.thresholds.findingFilter);
      expect(config.thresholds.mergeGate).toEqual(defaults.thresholds.mergeGate);
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
    expect(config.findingFilter).toEqual({
      mode: "annotate",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
    });
  });

  it('accepts an explicit findingFilter.mode: "discard"', async () => {
    const config = await loadJevestConfigFromString(
      "findingFilter:\n  mode: discard\n",
      "<config>",
    );
    expect(config.findingFilter).toEqual({
      mode: "discard",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
    });
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
    expect(config.findingFilter).toEqual({
      mode: "annotate",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
    });
  });

  it('defaults calibration to "none" — the identity, H3 pending (SPEC §4.6.3)', async () => {
    const config = await loadJevestConfigFromString("", "<config>");
    expect(config.findingFilter.calibration).toBe("none");
  });

  it('accepts calibration: "file" with the default path', async () => {
    const config = await loadJevestConfigFromString(
      "findingFilter:\n  calibration: file\n",
      "<config>",
    );
    expect(config.findingFilter.calibration).toBe("file");
    expect(config.findingFilter.calibrationPath).toBe(".jevest/calibration.json");
  });

  it("accepts a custom calibrationPath", async () => {
    const config = await loadJevestConfigFromString(
      "findingFilter:\n  calibration: file\n  calibrationPath: .jevest/my-map.json\n",
      "<config>",
    );
    expect(config.findingFilter.calibrationPath).toBe(".jevest/my-map.json");
  });

  it("rejects an unknown calibration source", async () => {
    await expect(
      loadJevestConfigFromString("findingFilter:\n  calibration: auto\n", "<config>"),
    ).rejects.toThrow(JevestConfigError);
  });

  it("rejects an empty calibrationPath", async () => {
    await expect(
      loadJevestConfigFromString('findingFilter:\n  calibrationPath: ""\n', "<config>"),
    ).rejects.toThrow(JevestConfigError);
  });

  it("keeps mode and calibration independent: setting one leaves the other at its default", async () => {
    const config = await loadJevestConfigFromString(
      "findingFilter:\n  calibration: file\n",
      "<config>",
    );
    expect(config.findingFilter.mode).toBe("annotate");
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

describe("strict config at every level (typo protection)", () => {
  const load = (yaml: string) => loadJevestConfigFromString(yaml, "<config>");

  it("rejects an unknown nested key, naming its full dotted path and the closest known key", async () => {
    await expect(load("reviewer:\n  mdoe: agentic\n")).rejects.toThrow(JevestConfigError);
    await expect(load("reviewer:\n  mdoe: agentic\n")).rejects.toThrow(
      "<config>: unknown config key `reviewer.mdoe` (did you mean `reviewer.mode`?)",
    );
  });

  it("names the path at every depth: reviewer.agentic, spendCap, triage, findingFilter, publish, sizeThresholds", async () => {
    const cases: Array<[string, string, string]> = [
      [
        "reviewer:\n  agentic:\n    maxTurn: 5\n",
        "reviewer.agentic.maxTurn",
        "reviewer.agentic.maxTurns",
      ],
      ["spendCap:\n  usdd: 5\n", "spendCap.usdd", "spendCap.usd"],
      ["triage:\n  changeSumary: never\n", "triage.changeSumary", "triage.changeSummary"],
      ["findingFilter:\n  mod: discard\n", "findingFilter.mod", "findingFilter.mode"],
      ["publish:\n  inlineComment: false\n", "publish.inlineComment", "publish.inlineComments"],
      [
        "sizeThresholds:\n  smallMaxChangedLine: 10\n",
        "sizeThresholds.smallMaxChangedLine",
        "sizeThresholds.smallMaxChangedLines",
      ],
    ];
    for (const [yaml, path, hint] of cases) {
      await expect(load(yaml)).rejects.toThrow(
        `unknown config key \`${path}\` (did you mean \`${hint}\`?)`,
      );
    }
  });

  it("rejects an unknown key inside a threshold band, naming stage and risk in the path", async () => {
    await expect(load("thresholds:\n  triage:\n    low:\n      autoMn: 0.9\n")).rejects.toThrow(
      "unknown config key `thresholds.triage.low.autoMn` (did you mean `thresholds.triage.low.autoMin`?)",
    );
  });

  it("rejects an unknown threshold stage or risk level, with a hint", async () => {
    await expect(load("thresholds:\n  mergeGat:\n    low:\n      autoMin: 0.9\n")).rejects.toThrow(
      "unknown config key `thresholds.mergeGat` (did you mean `thresholds.mergeGate`?)",
    );
    await expect(load("thresholds:\n  triage:\n    hihg:\n      autoMin: 0.99\n")).rejects.toThrow(
      "unknown config key `thresholds.triage.hihg` (did you mean `thresholds.triage.high`?)",
    );
    await expect(load("thresholds:\n  review:\n    low:\n      autoMin: 0.9\n")).rejects.toThrow(
      "unknown config key `thresholds.review`",
    );
  });

  it("loads the camelCase stage names into the confidence policy", async () => {
    const config = await load(
      "thresholds:\n  hunkProfile:\n    low:\n      autoMin: 0.91\n      confirmMin: 0.51\n",
    );
    expect(Object.keys(config.thresholds).sort()).toEqual([
      "findingFilter",
      "hunkProfile",
      "mergeGate",
      "triage",
    ]);
    expect(config.thresholds.hunkProfile!.low).toEqual({ autoMin: 0.91, confirmMin: 0.51 });
    expect(Object.keys(config.thresholds.mergeGate!).sort()).toEqual([
      "critical",
      "high",
      "low",
      "medium",
      "none",
    ]);
  });

  it("gives no hint when no known key is within edit distance 2", async () => {
    const error = await load("reviewer:\n  somethingElse: true\n").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevestConfigError);
    expect((error as Error).message).toContain("unknown config key `reviewer.somethingElse`");
    expect((error as Error).message).not.toContain("did you mean");
  });

  it("keeps the top-level typo protection, now with a hint", async () => {
    await expect(load("budgetUsdd: 1\n")).rejects.toThrow(
      "unknown config key `budgetUsdd` (did you mean `budgetUsd`?)",
    );
  });

  it("reports every unknown key at once", async () => {
    const error = await load("reviewer:\n  mdoe: agentic\nspendCap:\n  usdd: 5\n").catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("`reviewer.mdoe`");
    expect((error as Error).message).toContain("`spendCap.usdd`");
  });

  it("validates skipChangeKinds items against the hunk profile's change kinds", async () => {
    await expect(load("skipChangeKinds:\n  - rename-or-formatt\n")).rejects.toThrow(
      JevestConfigError,
    );
    await expect(load("skipChangeKinds:\n  - rename-or-formatt\n")).rejects.toThrow(
      /skipChangeKinds/,
    );
    const config = await load(
      "skipChangeKinds:\n  - add-behavior\n  - modify-behavior\n  - delete\n  - rename-or-format\n",
    );
    expect(config.skipChangeKinds).toEqual([
      "add-behavior",
      "modify-behavior",
      "delete",
      "rename-or-format",
    ]);
  });

  it("still loads the repo's own .jevest.yml and config/jevest.example.yml", async () => {
    const root = join(import.meta.dirname, "../../..");
    await expect(loadJevestConfig(join(root, ".jevest.yml"))).resolves.toBeDefined();
    await expect(loadJevestConfig(EXAMPLE_CONFIG_PATH)).resolves.toBeDefined();
  });
});

describe("0.1 key paths renamed in 1.0 get a targeted error", () => {
  const load = (yaml: string) => loadJevestConfigFromString(yaml, "<config>");
  const renamed = (from: string, to: string) =>
    `\`${from}\` was renamed to \`${to}\` in 1.0 — see docs/MIGRATING.md`;

  it("names the new path for every moved reviewer key", async () => {
    const cases: Array<[string, string, string]> = [
      ["reviewer:\n  verifier: claude-cli\n", "reviewer.verifier", "reviewer.verifier.provider"],
      ["reviewer:\n  verifier: none\n", "reviewer.verifier", "reviewer.verifier.provider"],
      ["reviewer:\n  verifierModel: m\n", "reviewer.verifierModel", "reviewer.verifier.model"],
      ["reviewer:\n  verifierEffort: low\n", "reviewer.verifierEffort", "reviewer.verifier.effort"],
      [
        "reviewer:\n  agentic:\n    verifierMaxTurns: 5\n",
        "reviewer.agentic.verifierMaxTurns",
        "reviewer.verifier.maxTurns",
      ],
      [
        "reviewer:\n  agentic:\n    verifierTimeoutMs: 5\n",
        "reviewer.agentic.verifierTimeoutMs",
        "reviewer.verifier.timeoutMs",
      ],
      ["reviewer:\n  fullFile: true\n", "reviewer.fullFile", "reviewer.hunks.fullFile"],
      [
        "reviewer:\n  impactContext: true\n",
        "reviewer.impactContext",
        "reviewer.hunks.impactContext",
      ],
      [
        "reviewer:\n  requireEvidence: true\n",
        "reviewer.requireEvidence",
        "reviewer.hunks.requireEvidence",
      ],
    ];
    for (const [yaml, from, to] of cases) {
      const error = await load(yaml).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JevestConfigError);
      expect((error as Error).message).toBe(`<config>: ${renamed(from, to)}`);
    }
  });

  it("names the camelCase path for the snake_case threshold stages and band keys", async () => {
    await expect(
      load("thresholds:\n  merge_gate:\n    low:\n      autoMin: 0.9\n"),
    ).rejects.toThrow(renamed("thresholds.merge_gate", "thresholds.mergeGate"));
    await expect(
      load("thresholds:\n  hunk_profile:\n    low:\n      autoMin: 0.9\n"),
    ).rejects.toThrow(renamed("thresholds.hunk_profile", "thresholds.hunkProfile"));
    await expect(
      load("thresholds:\n  finding_filter:\n    low:\n      autoMin: 0.9\n"),
    ).rejects.toThrow(renamed("thresholds.finding_filter", "thresholds.findingFilter"));
    await expect(load("thresholds:\n  triage:\n    low:\n      auto_min: 0.9\n")).rejects.toThrow(
      renamed("thresholds.triage.low.auto_min", "thresholds.triage.low.autoMin"),
    );
    await expect(
      load("thresholds:\n  triage:\n    low:\n      confirm_min: 0.5\n"),
    ).rejects.toThrow(
      renamed("thresholds.triage.low.confirm_min", "thresholds.triage.low.confirmMin"),
    );
  });

  it("reports a whole 0.1 threshold block at once, stage and band keys alike", async () => {
    const error = await load(
      "thresholds:\n  merge_gate:\n    low: { auto_min: 0.95, confirm_min: 0.7 }\n",
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain(renamed("thresholds.merge_gate", "thresholds.mergeGate"));
    expect(message).toContain(
      renamed("thresholds.merge_gate.low.auto_min", "thresholds.mergeGate.low.autoMin"),
    );
    expect(message).toContain(
      renamed("thresholds.merge_gate.low.confirm_min", "thresholds.mergeGate.low.confirmMin"),
    );
  });

  it("reports every renamed key in one error", async () => {
    const error = await load(
      "reviewer:\n  verifierModel: m\n  fullFile: true\nthresholds:\n  merge_gate: {}\n",
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain("`reviewer.verifierModel`");
    expect(message).toContain("`reviewer.fullFile`");
    expect(message).toContain("`thresholds.merge_gate`");
  });

  it("applies to eval overrides too: the 0.1 dotted paths are rejected with the new path", async () => {
    await expect(
      load("reviewer:\n  provider: claude-cli\n  verifier: claude-cli\n"),
    ).rejects.toThrow(/reviewer\.verifier\.provider/);
  });
});

describe("every .jevest.yml snippet in README.md and docs/*.md loads", () => {
  // A snippet is a .jevest.yml one when it is a mapping with at least one
  // config key; workflow (`jobs`, `steps`), product-context (`product`,
  // `areas`) and step-list snippets are other files.
  const CONFIG_KEYS = new Set([
    "reviewer",
    "thresholds",
    "sizeThresholds",
    "publish",
    "budgetUsd",
    "spendCap",
    "maxHunks",
    "skipChangeKinds",
    "failClosed",
    "triage",
    "findingFilter",
  ]);

  it("passes the strict loader (the docs never show a config that would be rejected)", async () => {
    const root = join(import.meta.dirname, "../../..");
    const docs = (await readdir(join(root, "docs"))).filter((f) => f.endsWith(".md"));
    const files = ["README.md", ...docs.map((f) => join("docs", f))];
    let checked = 0;
    for (const file of files) {
      const text = await readFile(join(root, file), "utf8");
      for (const match of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
        const yaml = match[1] ?? "";
        const parsed: unknown = parse(yaml);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (!Object.keys(parsed).some((key) => CONFIG_KEYS.has(key))) continue;
        const line = text.slice(0, match.index).split("\n").length;
        await expect(loadJevestConfigFromString(yaml, `${file}:${line}`)).resolves.toBeDefined();
        checked++;
      }
    }
    // Guards the extraction itself: the docs carry well over this many.
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});
