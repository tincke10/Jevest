import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PoliciesConfigError, loadPoliciesConfig } from "./policies-loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jevest-policies-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeYaml(content: string): Promise<string> {
  const filePath = join(dir, "policies.yaml");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("loadPoliciesConfig", () => {
  it("parses a valid stage -> risk -> thresholds mapping", async () => {
    const filePath = await writeYaml(`
triage:
  low:
    auto_min: 0.9
    confirm_min: 0.6
  high:
    auto_min: 0.99
    confirm_min: 0.8
merge_gate:
  low:
    auto_min: 0.95
    confirm_min: 0.7
`);

    const config = await loadPoliciesConfig(filePath);

    expect(config.triage!.low).toEqual({ autoMin: 0.9, confirmMin: 0.6 });
    expect(config.triage!.high).toEqual({ autoMin: 0.99, confirmMin: 0.8 });
    expect(config.merge_gate!.low).toEqual({ autoMin: 0.95, confirmMin: 0.7 });
  });

  it("loads the real repo config/policies.yaml with the four pipeline stages", async () => {
    const config = await loadPoliciesConfig(
      join(import.meta.dirname, "../../../config/policies.yaml"),
    );

    for (const stage of ["triage", "hunk_select", "finding_filter", "merge_gate"]) {
      expect(config[stage], `missing stage "${stage}"`).toBeDefined();
      expect(Object.keys(config[stage]!).length).toBeGreaterThan(0);
    }
  });

  it("throws when the top-level document is not a mapping", async () => {
    const filePath = await writeYaml("- a\n- b\n");
    await expect(loadPoliciesConfig(filePath)).rejects.toThrow(PoliciesConfigError);
  });

  it("throws when a stage does not map to an object", async () => {
    const filePath = await writeYaml(`triage: "not an object"\n`);
    await expect(loadPoliciesConfig(filePath)).rejects.toThrow(PoliciesConfigError);
  });

  it("throws when thresholds are missing auto_min or confirm_min", async () => {
    const filePath = await writeYaml(`
triage:
  low:
    auto_min: 0.9
`);
    await expect(loadPoliciesConfig(filePath)).rejects.toThrow(PoliciesConfigError);
  });

  it("throws when confirm_min is greater than auto_min", async () => {
    const filePath = await writeYaml(`
triage:
  low:
    auto_min: 0.5
    confirm_min: 0.9
`);
    await expect(loadPoliciesConfig(filePath)).rejects.toThrow(PoliciesConfigError);
  });

  it("throws a clear error when the file does not exist", async () => {
    await expect(loadPoliciesConfig(join(dir, "missing.yaml"))).rejects.toThrow();
  });
});
