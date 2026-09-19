import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevestConfigError, loadJevestConfig } from "./jevest-config.js";

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

  it("accepts the openai provider", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: openai\n  model: gpt-5.1\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    const config = await loadJevestConfig(filePath);
    expect(config.reviewer.provider).toBe("openai");
  });

  it("throws a clear error for an unknown provider", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: cohere\n  model: x\nthresholds: {}\nbudgetUsd: 1\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
    await expect(loadJevestConfig(filePath)).rejects.toThrow(/provider/i);
  });

  it("throws when budgetUsd is missing", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: anthropic\n  model: x\nthresholds: {}\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
  });

  it("throws when budgetUsd is not positive", async () => {
    const filePath = await writeConfig(
      "reviewer:\n  provider: anthropic\n  model: x\nthresholds: {}\nbudgetUsd: 0\nmaxHunks: 10\n",
    );
    await expect(loadJevestConfig(filePath)).rejects.toThrow(JevestConfigError);
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
});
