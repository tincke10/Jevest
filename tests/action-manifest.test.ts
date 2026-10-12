/**
 * Structural checks on action.yml and the release/CI workflows: the prebuilt
 * bundle path (dist/main.mjs, produced only by the Release workflow) must
 * skip pnpm entirely, and the source path must stay exactly as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  shell?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

function load(relativePath: string): Record<string, unknown> {
  return parse(readFileSync(join(ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

const action = load("action.yml") as { runs: { using: string; steps: Step[] } };
const steps = action.runs.steps;

function step(name: string): Step {
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`action.yml has no step named "${name}"`);
  return found;
}

const SKIP_WHEN_BUNDLED = "steps.bundle.outputs.bundled != 'true'";

describe("action.yml — prebuilt bundle", () => {
  it("detects dist/main.mjs in the action checkout as the first step", () => {
    const detect = steps[0]!;
    expect(detect.id).toBe("bundle");
    expect(detect.shell).toBe("bash");
    expect(detect.run).toContain('"$GITHUB_ACTION_PATH/dist/main.mjs"');
    expect(detect.run).toContain('echo "bundled=true" >> "$GITHUB_OUTPUT"');
    expect(detect.run).toContain('echo "bundled=false" >> "$GITHUB_OUTPUT"');
  });

  it("always sets up Node 22", () => {
    const node = step("Set up Node");
    expect(node.if).toBeUndefined();
    expect(node.uses).toMatch(/^actions\/setup-node@/);
    expect((node as { with?: Record<string, string> }).with?.["node-version"]).toBe("22");
  });

  it("sets up pnpm and installs dependencies only without a bundle", () => {
    expect(step("Set up pnpm").if).toBe(SKIP_WHEN_BUNDLED);
    const install = step("Install Jevest's own dependencies");
    expect(install.if).toBe(SKIP_WHEN_BUNDLED);
    expect(install.run).toBe("pnpm install --frozen-lockfile --prod=false");
  });

  it("leaves the Claude Code CLI install unconditional on the bundle", () => {
    expect(step("Install Claude Code CLI (claude-cli reviewer only)").if).toBe(
      "${{ inputs.claude-code-oauth-token != '' }}",
    );
  });

  it("runs the bundle with node when present, the source with tsx otherwise", () => {
    const run = step("Run Jevest");
    expect(run.if).toBeUndefined();
    expect(run["working-directory"]).toBe("${{ github.action_path }}");
    expect(run.env?.JEVEST_BUNDLED).toBe("${{ steps.bundle.outputs.bundled }}");
    const script = run.run ?? "";
    expect(script).toMatch(
      /if \[ "\$JEVEST_BUNDLED" = "true" \]; then\s+node --enable-source-maps dist\/main\.mjs\s+else\s+pnpm tsx src\/action\/main\.ts\s+fi/,
    );
  });

  it("orders detection before every step that depends on it", () => {
    const names = steps.map((s) => s.name);
    const detect = steps.findIndex((s) => s.id === "bundle");
    for (const name of ["Set up pnpm", "Install Jevest's own dependencies", "Run Jevest"]) {
      expect(names.indexOf(name)).toBeGreaterThan(detect);
    }
  });
});

describe(".github/workflows/release.yml", () => {
  const release = load(".github/workflows/release.yml") as {
    on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
  const releaseSteps = Object.values(release.jobs).flatMap((job) => job.steps);
  const script = releaseSteps.map((s) => s.run ?? "").join("\n");

  it("is a manual dispatch with version and move_major inputs", () => {
    const inputs = release.on.workflow_dispatch.inputs;
    expect(inputs.version).toBeDefined();
    expect(inputs.move_major).toMatchObject({ type: "boolean", default: true });
    expect(release.permissions).toEqual({ contents: "write" });
  });

  it("verifies, bundles, smoke-tests, then tags and releases", () => {
    const order = [
      "pnpm install --frozen-lockfile",
      "pnpm test",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm bundle",
      "node --enable-source-maps dist/main.mjs",
      "git tag -a",
      "gh release create",
    ];
    const positions = order.map((needle) => script.indexOf(needle));
    for (const [i, position] of positions.entries()) {
      expect(position, order[i]).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("never force-pushes anything but the floating major tag, at the peeled commit", () => {
    expect(script).toContain('git tag -f "$MAJOR" "$TAG^{}"');
    const forcePushes = script.split("\n").filter((line) => /git push.*(--force|-f\b)/.test(line));
    expect(forcePushes).toEqual([expect.stringContaining("refs/tags/$MAJOR")]);
  });

  it("refuses to run for a tag that already exists", () => {
    expect(script).toMatch(/already exists/);
  });
});

describe(".github/workflows/ci.yml", () => {
  it("fails a pull request that adds or changes dist/", () => {
    const ci = load(".github/workflows/ci.yml") as { jobs: Record<string, { steps: Step[] }> };
    const ciScript = Object.values(ci.jobs)
      .flatMap((job) => job.steps)
      .map((s) => s.run ?? "")
      .join("\n");
    expect(ciScript).toContain("git ls-files dist");
  });
});
