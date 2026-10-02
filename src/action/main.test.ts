import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JevestConfig, loadJevestConfigFromString } from "../adapters/config/jevest-config.js";
import type { GitHubVcsAdapter } from "../adapters/vcs/github-vcs-adapter.js";
import { ZERO_CODE_CONTEXT_METRICS, ZERO_WALL_TIMES } from "../application/pipeline/run-metrics.js";
import type { PipelineResult } from "../application/pipeline/run-pipeline.js";
import type { ReviewPublication } from "../domain/ports/vcs-port.js";
import type { PullRequestData, PullRequestRef } from "../domain/pull-request.js";
import type { SpendCapEvaluation } from "../domain/spend-cap.js";
import {
  ActionInputError,
  type ActionInputs,
  buildOutputLines,
  createAgenticPorts,
  createDescriptionContextExtractor,
  createNarrator,
  createReviewer,
  createSummarizer,
  loadPullRequestRefFromEvent,
  parseActionInputs,
  pullRequestRefFromEventPayload,
  resolveActionWorkingTree,
  resolveCalibration,
  resolveConfig,
  resolveProductContext,
  spendCapAnnotations,
  workingTreeAnnotations,
} from "./main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "../../tests/fixtures/github/pull_request.event.json");

const BASE_ENV: NodeJS.ProcessEnv = {
  INPUT_GITHUB_TOKEN: "ghp_test",
  INPUT_TYPESAFE_API_KEY: "ts_test",
};

describe("parseActionInputs", () => {
  it("applies defaults for config-path and fail-on when omitted", () => {
    const inputs = parseActionInputs(BASE_ENV);
    expect(inputs).toEqual({
      configPath: ".jevest.yml",
      configFromCheckout: false,
      typesafeApiKey: "ts_test",
      githubToken: "ghp_test",
      failOn: "never",
    });
  });

  it("reads every provided input, keyed by the GitHub Actions dash-preserving env convention", () => {
    const inputs = parseActionInputs({
      ...BASE_ENV,
      INPUT_CONFIG_PATH: "config/jevest.yml",
      INPUT_ANTHROPIC_API_KEY: "sk-ant-test",
      INPUT_OPENAI_API_KEY: "sk-oai-test",
      INPUT_DEEPSEEK_API_KEY: "sk-ds-test",
      INPUT_CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      INPUT_FAIL_ON: "failure",
      INPUT_CONFIG_FROM_CHECKOUT: "true",
    });
    expect(inputs).toEqual({
      configPath: "config/jevest.yml",
      configFromCheckout: true,
      typesafeApiKey: "ts_test",
      anthropicApiKey: "sk-ant-test",
      openaiApiKey: "sk-oai-test",
      deepseekApiKey: "sk-ds-test",
      claudeCodeOauthToken: "sk-ant-oat-test",
      githubToken: "ghp_test",
      failOn: "failure",
    });
  });

  it("throws when github-token is missing", () => {
    const { INPUT_GITHUB_TOKEN: _omit, ...rest } = BASE_ENV;
    expect(() => parseActionInputs(rest)).toThrow(ActionInputError);
  });

  it("throws when typesafe-api-key is missing", () => {
    const { INPUT_TYPESAFE_API_KEY: _omit, ...rest } = BASE_ENV;
    expect(() => parseActionInputs(rest)).toThrow(ActionInputError);
  });

  it('throws on a config-from-checkout value other than "true" or "false"', () => {
    expect(() => parseActionInputs({ ...BASE_ENV, INPUT_CONFIG_FROM_CHECKOUT: "yes" })).toThrow(
      ActionInputError,
    );
    expect(parseActionInputs({ ...BASE_ENV, INPUT_CONFIG_FROM_CHECKOUT: "false" })).toMatchObject({
      configFromCheckout: false,
    });
  });

  it("throws on an invalid fail-on value", () => {
    expect(() => parseActionInputs({ ...BASE_ENV, INPUT_FAIL_ON: "always" })).toThrow(
      ActionInputError,
    );
  });
});

describe("pullRequestRefFromEventPayload", () => {
  it("resolves a PullRequestRef from a pull_request event payload", () => {
    const ref = pullRequestRefFromEventPayload({
      number: 42,
      pull_request: {
        number: 42,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
      },
      repository: { name: "jevest", owner: { login: "tincke10" } },
    });
    expect(ref).toEqual({
      owner: "tincke10",
      repo: "jevest",
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
  });

  it("throws when the payload has no pull_request (wrong event type)", () => {
    expect(() =>
      pullRequestRefFromEventPayload({ repository: { name: "jevest", owner: { login: "x" } } }),
    ).toThrow(ActionInputError);
  });

  it("throws when the payload has no repository", () => {
    expect(() =>
      pullRequestRefFromEventPayload({
        pull_request: { number: 1, head: { sha: "h" }, base: { sha: "b" } },
      }),
    ).toThrow(ActionInputError);
  });
});

function makeConfig(overrides: Partial<JevestConfig["reviewer"]> = {}): JevestConfig {
  return {
    reviewer: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      language: "es",
      narrative: true,
      descriptionContext: true,
      fullFile: false,
      impactContext: false,
      requireEvidence: false,
      mode: "hunks",
      agentic: {
        maxTurns: 40,
        timeoutMs: 900_000,
        verifierMaxTurns: 12,
        verifierTimeoutMs: 300_000,
        effort: "high",
      },
      verifier: "none",
      verifierModel: "claude-sonnet-5",
      verifierEffort: "medium",
      ...overrides,
    },
    thresholds: {},
    sizeThresholds: { smallMaxChangedLines: 50, mediumMaxChangedLines: 300 },
    publish: { inlineComments: true },
    budgetUsd: 5,
    spendCap: { usd: 50, period: "month", warnAtUsd: 40 },
    maxHunks: 50,
    skipChangeKinds: [],
    failClosed: true,
    triage: { productContextPath: ".jevest/context.yml", changeSummary: "auto" },
    findingFilter: {
      mode: "annotate",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
    },
  };
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    configPath: ".jevest.yml",
    configFromCheckout: false,
    typesafeApiKey: "ts_test",
    githubToken: "ghp_test",
    failOn: "never",
    ...overrides,
  };
}

describe("createReviewer", () => {
  it("returns undefined and requires no LLM key when provider is 'none' (Jev-only mode)", () => {
    const config = makeConfig({ provider: "none", model: undefined });
    const reviewer = createReviewer(config, makeInputs());
    expect(reviewer).toBeUndefined();
  });

  it("builds an anthropic reviewer when an anthropic key is provided", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-5" });
    const reviewer = createReviewer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }));
    expect(reviewer).toBeDefined();
  });

  it("throws when provider is anthropic but no anthropic-api-key input was given", () => {
    const config = makeConfig({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(() => createReviewer(config, makeInputs())).toThrow(ActionInputError);
  });

  it("throws when provider is openai but no openai-api-key input was given", () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.1" });
    expect(() => createReviewer(config, makeInputs())).toThrow(ActionInputError);
  });

  it("builds a deepseek reviewer when a deepseek key is provided", () => {
    const config = makeConfig({ provider: "deepseek", model: "deepseek-v4-pro" });
    const reviewer = createReviewer(config, makeInputs({ deepseekApiKey: "sk-ds-test" }));
    expect(reviewer).toBeDefined();
  });

  it("throws when provider is deepseek but no deepseek-api-key input was given", () => {
    const config = makeConfig({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(() => createReviewer(config, makeInputs())).toThrow(/deepseek-api-key/);
  });

  it("builds a claude-cli reviewer when a Claude Code OAuth token is provided", () => {
    const config = makeConfig({ provider: "claude-cli", model: "claude-opus-5" });
    const reviewer = createReviewer(
      config,
      makeInputs({ claudeCodeOauthToken: "sk-ant-oat-test" }),
    );
    expect(reviewer).toBeDefined();
  });

  it("throws when provider is claude-cli but no claude-code-oauth-token input was given", () => {
    const config = makeConfig({ provider: "claude-cli", model: "claude-opus-5" });
    expect(() => createReviewer(config, makeInputs())).toThrow(/claude-code-oauth-token/);
  });

  it("says how to fix a missing claude-code-oauth-token: the input to add, or the provider to pick (a 0.1 workflow upgrading lands here)", () => {
    const config = makeConfig({
      provider: "claude-cli",
      model: "claude-opus-5-5",
      mode: "agentic",
    });
    const run = () => createReviewer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }));
    expect(run).toThrow(/claude-code-oauth-token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
    expect(run).toThrow(/the default since 1\.0/);
    expect(run).toThrow(/reviewer\.provider: anthropic/);
    expect(run).toThrow(/docs\/MIGRATING\.md/);
  });

  it("throws a clear error if model is missing for a non-none provider (defensive; config validation should already catch this)", () => {
    const config = makeConfig({ provider: "anthropic", model: undefined });
    expect(() => createReviewer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }))).toThrow(
      /reviewer\.model is required/,
    );
  });
});

describe("createSummarizer", () => {
  function withSummary(
    reviewer: Partial<JevestConfig["reviewer"]>,
    changeSummary: JevestConfig["triage"]["changeSummary"] = "auto",
  ): JevestConfig {
    return {
      ...makeConfig(reviewer),
      triage: { productContextPath: ".jevest/context.yml", changeSummary },
    };
  }

  it("returns undefined when changeSummary is never, whatever the provider", () => {
    const config = withSummary({ provider: "anthropic", model: "claude-sonnet-5" }, "never");
    expect(
      createSummarizer(config, makeInputs({ anthropicApiKey: "sk-ant-test" })),
    ).toBeUndefined();
  });

  it("returns undefined and requires no LLM key in Jev-only mode (provider none, auto)", () => {
    const config = withSummary({ provider: "none", model: undefined });
    expect(createSummarizer(config, makeInputs())).toBeUndefined();
  });

  it("builds an anthropic summarizer with the reviewer's model when the anthropic key is provided", () => {
    const config = withSummary({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(createSummarizer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }))).toBeDefined();
  });

  it("throws the same key error as the reviewer when the anthropic key is missing", () => {
    const config = withSummary({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(() => createSummarizer(config, makeInputs())).toThrow(/anthropic-api-key/);
  });

  it("builds openai, deepseek and claude-cli summarizers with their respective credentials", () => {
    expect(
      createSummarizer(
        withSummary({ provider: "openai", model: "gpt-5.6-luna" }),
        makeInputs({ openaiApiKey: "sk-oa" }),
      ),
    ).toBeDefined();
    expect(
      createSummarizer(
        withSummary({ provider: "deepseek", model: "deepseek-v4-pro" }),
        makeInputs({ deepseekApiKey: "sk-ds" }),
      ),
    ).toBeDefined();
    expect(
      createSummarizer(
        withSummary({ provider: "claude-cli", model: "claude-opus-5" }),
        makeInputs({ claudeCodeOauthToken: "sk-ant-oat" }),
      ),
    ).toBeDefined();
  });

  it("throws naming the missing credential for openai, deepseek and claude-cli", () => {
    expect(() =>
      createSummarizer(withSummary({ provider: "openai", model: "gpt-5.6-luna" }), makeInputs()),
    ).toThrow(/openai-api-key/);
    expect(() =>
      createSummarizer(
        withSummary({ provider: "deepseek", model: "deepseek-v4-pro" }),
        makeInputs(),
      ),
    ).toThrow(/deepseek-api-key/);
    expect(() =>
      createSummarizer(
        withSummary({ provider: "claude-cli", model: "claude-opus-5" }),
        makeInputs(),
      ),
    ).toThrow(/claude-code-oauth-token/);
  });

  it("builds a summarizer under always with an LLM provider (config validation forbids always + none)", () => {
    const config = withSummary({ provider: "anthropic", model: "claude-sonnet-5" }, "always");
    expect(createSummarizer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }))).toBeDefined();
  });
});

describe("createDescriptionContextExtractor", () => {
  it("returns undefined when reviewer.descriptionContext is false, or in Jev-only mode, requiring no key", () => {
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "anthropic", descriptionContext: false }),
        makeInputs(),
      ),
    ).toBeUndefined();
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "none", model: undefined, descriptionContext: false }),
        makeInputs(),
      ),
    ).toBeUndefined();
  });

  it("builds an extractor for every LLM provider with the reviewer's credential", () => {
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "anthropic", model: "claude-sonnet-5" }),
        makeInputs({ anthropicApiKey: "sk-ant-test" }),
      ),
    ).toBeDefined();
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "openai", model: "gpt-5.6-luna" }),
        makeInputs({ openaiApiKey: "sk-openai" }),
      ),
    ).toBeDefined();
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "deepseek", model: "deepseek-v4-pro" }),
        makeInputs({ deepseekApiKey: "sk-ds" }),
      ),
    ).toBeDefined();
    expect(
      createDescriptionContextExtractor(
        makeConfig({ provider: "claude-cli", model: "claude-opus-5" }),
        makeInputs({ claudeCodeOauthToken: "sk-ant-oat" }),
      ),
    ).toBeDefined();
  });

  it("throws naming the missing credential", () => {
    for (const [provider, input] of [
      ["anthropic", /anthropic-api-key/],
      ["openai", /openai-api-key/],
      ["deepseek", /deepseek-api-key/],
      ["claude-cli", /claude-code-oauth-token/],
    ] as const) {
      expect(() =>
        createDescriptionContextExtractor(makeConfig({ provider, model: "m" }), makeInputs()),
      ).toThrow(input);
    }
  });
});

describe("createNarrator", () => {
  function withNarrative(reviewer: Partial<JevestConfig["reviewer"]>): JevestConfig {
    return makeConfig(reviewer);
  }

  it("returns undefined when reviewer.narrative is false, requiring no key", () => {
    expect(
      createNarrator(withNarrative({ provider: "anthropic", narrative: false }), makeInputs()),
    ).toBeUndefined();
  });

  it("returns undefined in Jev-only mode (provider none)", () => {
    expect(
      createNarrator(
        withNarrative({ provider: "none", model: undefined, narrative: false }),
        makeInputs(),
      ),
    ).toBeUndefined();
  });

  it("builds a narrator for every LLM provider with the reviewer's credential", () => {
    expect(
      createNarrator(
        withNarrative({ provider: "anthropic", model: "claude-sonnet-5" }),
        makeInputs({ anthropicApiKey: "sk-ant-test" }),
      ),
    ).toBeDefined();
    expect(
      createNarrator(
        withNarrative({ provider: "openai", model: "gpt-5.6-luna" }),
        makeInputs({ openaiApiKey: "sk-oa" }),
      ),
    ).toBeDefined();
    expect(
      createNarrator(
        withNarrative({ provider: "deepseek", model: "deepseek-v4-pro" }),
        makeInputs({ deepseekApiKey: "sk-ds" }),
      ),
    ).toBeDefined();
    expect(
      createNarrator(
        withNarrative({ provider: "claude-cli", model: "claude-opus-5" }),
        makeInputs({ claudeCodeOauthToken: "sk-ant-oat" }),
      ),
    ).toBeDefined();
  });

  it("throws naming the missing credential", () => {
    expect(() =>
      createNarrator(withNarrative({ provider: "anthropic", model: "m" }), makeInputs()),
    ).toThrow(/anthropic-api-key/);
    expect(() =>
      createNarrator(withNarrative({ provider: "openai", model: "m" }), makeInputs()),
    ).toThrow(/openai-api-key/);
    expect(() =>
      createNarrator(withNarrative({ provider: "deepseek", model: "m" }), makeInputs()),
    ).toThrow(/deepseek-api-key/);
    expect(() =>
      createNarrator(withNarrative({ provider: "claude-cli", model: "m" }), makeInputs()),
    ).toThrow(/claude-code-oauth-token/);
  });
});

describe("resolveProductContext", () => {
  it("fetches the context file from the PR BASE sha via the API, never the head or the local checkout", async () => {
    const fetchRepoFileContent = vi
      .fn()
      .mockResolvedValue("areas:\n  - name: core\n    paths: ['src/**']\n    criticality: high\n");
    const vcs = makeFakeVcs(fetchRepoFileContent);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const context = await resolveProductContext(vcs, REF, ".jevest/context.yml");

    expect(context.areas.map((a) => a.name)).toEqual(["core"]);
    expect(fetchRepoFileContent).toHaveBeenCalledWith({
      owner: "tincke10",
      repo: "jevest",
      path: ".jevest/context.yml",
      ref: "base-sha",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("base-sha"));
    log.mockRestore();
  });

  it("returns the empty context, logging one line, when the file does not exist at the base sha", async () => {
    const vcs = makeFakeVcs(vi.fn().mockResolvedValue(null));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const context = await resolveProductContext(vcs, REF, ".jevest/context.yml");
    expect(context.areas).toEqual([]);
    expect(context.product).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no product context"));
    log.mockRestore();
  });

  it("throws naming the source when the file is invalid (fail closed, like a bad .jevest.yml)", async () => {
    const vcs = makeFakeVcs(vi.fn().mockResolvedValue("areas: ["));
    await expect(resolveProductContext(vcs, REF, ".jevest/context.yml")).rejects.toThrow(
      /tincke10\/jevest@base-sha:\.jevest\/context\.yml/,
    );
  });

  it("propagates a non-404 API failure (fail closed)", async () => {
    const vcs = makeFakeVcs(vi.fn().mockRejectedValue(new Error("contents API 500")));
    await expect(resolveProductContext(vcs, REF, ".jevest/context.yml")).rejects.toThrow(
      "contents API 500",
    );
  });
});

describe("resolveCalibration", () => {
  const VALID = JSON.stringify({
    version: 1,
    question: "is_real_defect",
    map: { method: "platt", a: 0.95, b: -1.65 },
  });

  function findingFilter(
    overrides: Partial<JevestConfig["findingFilter"]> = {},
  ): JevestConfig["findingFilter"] {
    return {
      mode: "annotate",
      calibration: "none",
      calibrationPath: ".jevest/calibration.json",
      ...overrides,
    };
  }

  it('does not call the API at all when calibration is "none" (the default)', async () => {
    const fetchRepoFileContent = vi.fn();
    const map = await resolveCalibration(makeFakeVcs(fetchRepoFileContent), REF, findingFilter());
    expect(map).toEqual({ method: "none" });
    expect(fetchRepoFileContent).not.toHaveBeenCalled();
  });

  it("fetches the map from the PR BASE sha, never the head", async () => {
    const fetchRepoFileContent = vi.fn().mockResolvedValue(VALID);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const map = await resolveCalibration(
      makeFakeVcs(fetchRepoFileContent),
      REF,
      findingFilter({ calibration: "file" }),
    );

    expect(map).toEqual({ method: "platt", a: 0.95, b: -1.65 });
    expect(fetchRepoFileContent).toHaveBeenCalledWith({
      owner: "tincke10",
      repo: "jevest",
      path: ".jevest/calibration.json",
      ref: "base-sha",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("base-sha"));
    log.mockRestore();
  });

  it("throws naming the source when the file is missing but the config asked for it", async () => {
    const vcs = makeFakeVcs(vi.fn().mockResolvedValue(null));
    await expect(
      resolveCalibration(vcs, REF, findingFilter({ calibration: "file" })),
    ).rejects.toThrow(/tincke10\/jevest@base-sha:\.jevest\/calibration\.json/);
  });

  it("throws naming the source on an invalid map, rather than silently falling back to the identity", async () => {
    const vcs = makeFakeVcs(vi.fn().mockResolvedValue('{"version":1,"question":"nope"}'));
    await expect(
      resolveCalibration(vcs, REF, findingFilter({ calibration: "file" })),
    ).rejects.toThrow(/tincke10\/jevest@base-sha:\.jevest\/calibration\.json/);
  });

  it("honors a custom calibrationPath", async () => {
    const fetchRepoFileContent = vi.fn().mockResolvedValue(VALID);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await resolveCalibration(
      makeFakeVcs(fetchRepoFileContent),
      REF,
      findingFilter({ calibration: "file", calibrationPath: "calib/map.json" }),
    );
    expect(fetchRepoFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: "calib/map.json" }),
    );
    log.mockRestore();
  });
});

describe("loadPullRequestRefFromEvent", () => {
  it("resolves the ref from the sample pull_request event fixture", async () => {
    const ref = await loadPullRequestRefFromEvent(FIXTURE_PATH);
    expect(ref).toEqual({
      owner: "tincke10",
      repo: "jevest",
      number: 42,
      headSha: "abc123headsha0000000000000000000000000",
      baseSha: "def456basesha0000000000000000000000000",
    });
  });
});

const REF: PullRequestRef = {
  owner: "tincke10",
  repo: "jevest",
  number: 42,
  headSha: "head-sha",
  baseSha: "base-sha",
};

function makeFakeVcs(
  fetchRepoFileContent: GitHubVcsAdapter["fetchRepoFileContent"],
): GitHubVcsAdapter {
  return {
    fetchPullRequest: vi.fn<() => Promise<PullRequestData>>(),
    publishReview: vi.fn<(ref: PullRequestRef, publication: ReviewPublication) => Promise<void>>(),
    fetchRepoFileContent,
  };
}

describe("resolveConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-action-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("by default (config-from-checkout: false): always the PR BASE sha via the API", () => {
    it("ignores a config in the checkout, which may be the PR head (agentic mode): a PR must not choose its own config", async () => {
      vi.stubEnv("GITHUB_WORKSPACE", dir);
      await writeFile(join(dir, ".jevest.yml"), "budgetUsd: 999\n", "utf8");
      const fetchRepoFileContent = vi.fn().mockResolvedValue("budgetUsd: 7\n");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const config = await resolveConfig(makeFakeVcs(fetchRepoFileContent), REF, ".jevest.yml");

      expect(config.budgetUsd).toBe(7);
      expect(fetchRepoFileContent).toHaveBeenCalledWith({
        owner: "tincke10",
        repo: "jevest",
        path: ".jevest.yml",
        ref: "base-sha",
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("via the GitHub API"));
      log.mockRestore();
    });

    it("falls back to the built-in defaults, logging one line, when the file is absent at the base sha", async () => {
      vi.stubEnv("GITHUB_WORKSPACE", dir);
      await writeFile(join(dir, ".jevest.yml"), "budgetUsd: 999\n", "utf8");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const defaults = await loadJevestConfigFromString("");

      const config = await resolveConfig(
        makeFakeVcs(vi.fn().mockResolvedValue(null)),
        REF,
        ".jevest.yml",
      );

      expect(config).toEqual(defaults);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("using the built-in defaults"));
      log.mockRestore();
    });

    it("propagates an API failure (fail closed) instead of reading the checkout", async () => {
      vi.stubEnv("GITHUB_WORKSPACE", dir);
      await writeFile(join(dir, ".jevest.yml"), "budgetUsd: 999\n", "utf8");
      const vcs = makeFakeVcs(vi.fn().mockRejectedValue(new Error("502")));

      await expect(resolveConfig(vcs, REF, ".jevest.yml")).rejects.toThrow("502");
    });
  });

  describe("config-from-checkout: true (explicit opt-in)", () => {
    const fromCheckout = { fromCheckout: true };

    it("reads config-path off the local checkout when it exists, without calling the GitHub API", async () => {
      const configPath = join(dir, ".jevest.yml");
      await writeFile(configPath, "budgetUsd: 3\n", "utf8");
      const fetchRepoFileContent = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const config = await resolveConfig(
        makeFakeVcs(fetchRepoFileContent),
        REF,
        configPath,
        fromCheckout,
      );

      expect(config.budgetUsd).toBe(3);
      expect(fetchRepoFileContent).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("local checkout"));
      log.mockRestore();
    });

    it("resolves a relative config-path against GITHUB_WORKSPACE, never the action's own directory (the step's cwd holds Jevest's own .jevest.yml)", async () => {
      // cwd here is the Jevest repo root, which HAS a .jevest.yml, exactly like
      // the composite step whose working-directory is github.action_path.
      vi.stubEnv("GITHUB_WORKSPACE", dir);
      const fetchRepoFileContent = vi.fn().mockResolvedValue("budgetUsd: 7\n");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const config = await resolveConfig(
        makeFakeVcs(fetchRepoFileContent),
        REF,
        ".jevest.yml",
        fromCheckout,
      );

      expect(config.budgetUsd).toBe(7);
      expect(fetchRepoFileContent).toHaveBeenCalledWith({
        owner: "tincke10",
        repo: "jevest",
        path: ".jevest.yml",
        ref: "base-sha",
      });
      log.mockRestore();
    });

    it("reads a relative config-path from GITHUB_WORKSPACE when the consumer checked out", async () => {
      vi.stubEnv("GITHUB_WORKSPACE", dir);
      await writeFile(join(dir, ".jevest.yml"), "budgetUsd: 4\n", "utf8");
      const fetchRepoFileContent = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const config = await resolveConfig(
        makeFakeVcs(fetchRepoFileContent),
        REF,
        ".jevest.yml",
        fromCheckout,
      );

      expect(config.budgetUsd).toBe(4);
      expect(fetchRepoFileContent).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it("falls back to the built-in defaults when the file is absent both locally and in the repo", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const defaults = await loadJevestConfigFromString("");

      const config = await resolveConfig(
        makeFakeVcs(vi.fn().mockResolvedValue(null)),
        REF,
        join(dir, "does-not-exist.jevest.yml"),
        fromCheckout,
      );

      expect(config).toEqual(defaults);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("using the built-in defaults"));
      log.mockRestore();
    });

    it("propagates a non-ENOENT local read error instead of falling through to the API", async () => {
      // `dir` itself is a directory, not a file: readFile on it reliably fails EISDIR, not ENOENT.
      const fetchRepoFileContent = vi.fn();

      await expect(
        resolveConfig(makeFakeVcs(fetchRepoFileContent), REF, dir, fromCheckout),
      ).rejects.toThrow();
      expect(fetchRepoFileContent).not.toHaveBeenCalled();
    });
  });
});

function makeResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  const publication: ReviewPublication = {
    summaryMarkdown: "",
    summaryFingerprint: "fp",
    inlineComments: [],
    labelsToAdd: [],
    labelsToRemove: [],
    check: { conclusion: "success", title: "Jevest: success", summary: "ok" },
  };
  return {
    ref: { owner: "acme", repo: "widgets", number: 1, headSha: "h", baseSha: "b" },
    failedClosed: false,
    failureReason: null,
    triage: null,
    hunkProfile: null,
    review: null,
    findingFilter: null,
    mergeGate: null,
    narrative: null,
    descriptionContext: null,
    codeContext: null,
    publication,
    check: publication.check,
    verdict: "clear",
    findingsPublished: 2,
    findingsLowConfidence: 3,
    costUsd: 0.1234,
    spendCap: null,
    reviewSkippedForSpendCap: false,
    spendLedgerError: null,
    metrics: {
      jev: {
        requests: { triage: 1, hunkProfile: 3, findingFilter: 1, mergeGate: 1, total: 6 },
        latency: { sumMs: 1400, p50Ms: 200, p95Ms: 400, maxMs: 400 },
        usage: { inputTokens: 1540, outputTokens: 83 },
        costUsd: 0.00006468,
      },
      llm: {
        hunks: {
          total: 5,
          eligible: 3,
          reviewed: 2,
          failed: 0,
          withSecret: 0,
          skipped: {
            triageSkip: 0,
            skipChangeKind: 1,
            budget: 2,
            spendCap: 0,
            reviewerDisabled: 0,
            total: 3,
          },
          truncatedByMaxHunks: 0,
        },
        tokens: {
          reviewInput: 2000,
          reviewOutput: 200,
          summaryInput: 500,
          summaryOutput: 80,
          spent: 2780,
        },
        tokensWithoutJev: 4000,
        tokensSavedPct: 30.5,
        method: "estimate",
      },
      wallTime: ZERO_WALL_TIMES,
      codeContext: ZERO_CODE_CONTEXT_METRICS,
    },
    ...overrides,
  };
}

function evaluation(overrides: Partial<SpendCapEvaluation> = {}): SpendCapEvaluation {
  return {
    status: "ok",
    period: "month",
    periodKey: "2026-09",
    spentUsd: 12.5,
    capUsd: 50,
    warnAtUsd: 40,
    remainingUsd: 37.5,
    effectiveBudgetUsd: 5,
    ...overrides,
  };
}

describe("buildOutputLines", () => {
  it("emits the nine outputs, with spend-usd as the cumulative total after this run and the H2 / H4 numbers", () => {
    expect(buildOutputLines(makeResult({ spendCap: evaluation() }))).toBe(
      "check-conclusion=success\nverdict=clear\nfindings-published=2\nfindings-low-confidence=3\ncost-usd=0.1234\nspend-usd=12.5\n" +
        "jev-latency-p95-ms=400\njev-requests=6\nllm-tokens-saved-pct=30.5\n",
    );
  });

  it("emits the verdict next to the check conclusion, which it does not always match (fail closed: failure / unavailable)", () => {
    const failedClosed = makeResult({
      failedClosed: true,
      check: { conclusion: "failure", title: "t", summary: "s" },
      verdict: "unavailable",
    });
    expect(buildOutputLines(failedClosed)).toContain(
      "check-conclusion=failure\nverdict=unavailable\n",
    );
    for (const verdict of ["fix", "questions", "clear", "unavailable"] as const) {
      expect(buildOutputLines(makeResult({ verdict }))).toContain(`\nverdict=${verdict}\n`);
    }
  });

  it("emits an empty spend-usd when the cumulative total is unknown", () => {
    expect(buildOutputLines(makeResult())).toContain("spend-usd=\n");
  });
});

describe("spendCapAnnotations", () => {
  it("emits nothing when the cap is ok and the ledger worked", () => {
    expect(spendCapAnnotations(makeResult({ spendCap: evaluation() }))).toEqual([]);
  });

  it("emits a ::warning:: on warning", () => {
    expect(
      spendCapAnnotations(
        makeResult({ spendCap: evaluation({ status: "warning", spentUsd: 42 }) }),
      ),
    ).toEqual(["::warning::Jevest spend cap: USD 42.00 of 50.00 (period 2026-09) — warning"]);
  });

  it("emits a ::warning:: (never ::error::) on reached, so the job does not fail", () => {
    const lines = spendCapAnnotations(
      makeResult({
        spendCap: evaluation({ status: "reached", spentUsd: 50.2 }),
        reviewSkippedForSpendCap: true,
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::warning::Jevest spend cap: USD 50.20 of 50.00 \(period 2026-09\) — reached/,
    );
    expect(lines[0]).toContain("LLM review skipped");
  });

  it("emits a ::warning:: when the ledger was unavailable", () => {
    expect(spendCapAnnotations(makeResult({ spendLedgerError: "issues 500" }))).toEqual([
      "::warning::Jevest spend ledger unavailable: issues 500 — cumulative cap not enforced on this run",
    ]);
  });
});

describe("createAgenticPorts (reviewer.mode: agentic)", () => {
  const AGENTIC = {
    provider: "claude-cli" as const,
    model: "claude-opus-5",
    mode: "agentic" as const,
  };

  it("builds nothing in the per-hunk mode", () => {
    expect(createAgenticPorts(makeConfig(), makeInputs())).toEqual({});
  });

  it("builds the agent, and the verifier only when configured", () => {
    const token = { claudeCodeOauthToken: "oauth-test" };
    const agentOnly = createAgenticPorts(makeConfig(AGENTIC), makeInputs(token));
    expect(agentOnly.agenticReviewer).toBeDefined();
    expect(agentOnly.findingVerifier).toBeUndefined();
    const both = createAgenticPorts(
      makeConfig({ ...AGENTIC, verifier: "claude-cli" }),
      makeInputs(token),
    );
    expect(both.findingVerifier).toBeDefined();
  });

  it("requires the claude-code-oauth-token input", () => {
    expect(() => createAgenticPorts(makeConfig(AGENTIC), makeInputs())).toThrow(ActionInputError);
  });
});

describe("workingTreeAnnotations", () => {
  const AGENTIC = makeConfig({ provider: "claude-cli", model: "m", mode: "agentic" });

  it("warns in the workflow log with the exact checkout step when agentic mode has no checkout", () => {
    const [line, ...rest] = workingTreeAnnotations(AGENTIC, "no checkout");
    expect(rest).toEqual([]);
    expect(line).toMatch(/^::warning title=Jevest agentic review needs a checkout::/);
    expect(line).toContain("actions/checkout@v4");
    expect(line).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(line).toContain("fetch-depth: 1");
    expect(line).toContain("reviewer.mode: hunks");
    expect(line).not.toContain("\n");
  });

  it("is a plain log line for the optional code-context layers, and nothing with a checkout", () => {
    expect(workingTreeAnnotations(makeConfig({ impactContext: true }), "no checkout")).toEqual([
      "jevest: code context unavailable: no checkout",
    ]);
    expect(workingTreeAnnotations(AGENTIC, undefined)).toEqual([]);
  });
});

describe("resolveActionWorkingTree (code context in the Action)", () => {
  const REF: PullRequestRef = {
    owner: "acme",
    repo: "widgets",
    number: 7,
    headSha: "abc123head",
    baseSha: "def456base",
  };
  const ON = makeConfig({ impactContext: true });

  it("does nothing when every layer is off", async () => {
    let probed = false;
    const resolved = await resolveActionWorkingTree(makeConfig(), REF, "/ws", {
      hasGitDir: async () => {
        probed = true;
        return true;
      },
      headSha: async () => REF.headSha,
    });
    expect(probed).toBe(false);
    expect(resolved).toEqual({});
  });

  it("uses the workspace when it is a checkout of the PR head", async () => {
    const resolved = await resolveActionWorkingTree(ON, REF, "/ws", {
      hasGitDir: async () => true,
      headSha: async (dir) => {
        expect(dir).toBe("/ws");
        return `${REF.headSha}\n`;
      },
    });
    expect(resolved.workingTree).toBeDefined();
    expect(resolved.root).toBe("/ws");
    expect(resolved.unavailableReason).toBeUndefined();
  });

  it("wants the checkout in agentic mode, whatever the code-context layers say", async () => {
    const resolved = await resolveActionWorkingTree(
      makeConfig({ provider: "claude-cli", model: "m", mode: "agentic" }),
      REF,
      "/ws",
      { hasGitDir: async () => true, headSha: async () => REF.headSha },
    );
    expect(resolved.root).toBe("/ws");
    expect(resolved.workingTree).toBeDefined();
  });

  it("has no checkout without a workspace or without .git", async () => {
    expect(
      await resolveActionWorkingTree(ON, REF, undefined, {
        hasGitDir: async () => true,
        headSha: async () => REF.headSha,
      }),
    ).toEqual({ unavailableReason: "no checkout" });
    expect(
      await resolveActionWorkingTree(ON, REF, "/ws", {
        hasGitDir: async () => false,
        headSha: async () => REF.headSha,
      }),
    ).toEqual({ unavailableReason: "no checkout" });
  });

  it("refuses a checkout of another commit (e.g. the default merge ref), naming it", async () => {
    const resolved = await resolveActionWorkingTree(ON, REF, "/ws", {
      hasGitDir: async () => true,
      headSha: async () => "0123456789merge",
    });
    expect(resolved.workingTree).toBeUndefined();
    expect(resolved.unavailableReason).toBe(
      "no checkout of the PR head (the workspace is at 0123456; check out ref: the PR head sha)",
    );
  });

  it("treats a git error as no checkout", async () => {
    const resolved = await resolveActionWorkingTree(ON, REF, "/ws", {
      hasGitDir: async () => true,
      headSha: async () => {
        throw new Error("not a git repository");
      },
    });
    expect(resolved).toEqual({ unavailableReason: "no checkout" });
  });
});
