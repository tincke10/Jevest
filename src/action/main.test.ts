import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevestConfig } from "../adapters/config/jevest-config.js";
import type { GitHubVcsAdapter } from "../adapters/vcs/github-vcs-adapter.js";
import type { ReviewPublication } from "../domain/ports/vcs-port.js";
import type { PullRequestData, PullRequestRef } from "../domain/pull-request.js";
import {
  ActionInputError,
  type ActionInputs,
  createReviewer,
  loadPullRequestRefFromEvent,
  parseActionInputs,
  pullRequestRefFromEventPayload,
  resolveConfig,
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
      INPUT_FAIL_ON: "failure",
    });
    expect(inputs).toEqual({
      configPath: "config/jevest.yml",
      typesafeApiKey: "ts_test",
      anthropicApiKey: "sk-ant-test",
      openaiApiKey: "sk-oai-test",
      deepseekApiKey: "sk-ds-test",
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
    reviewer: { provider: "anthropic", model: "claude-sonnet-5", ...overrides },
    thresholds: {},
    sizeThresholds: { smallMaxChangedLines: 50, mediumMaxChangedLines: 300 },
    publish: { inlineComments: true },
    budgetUsd: 5,
    maxHunks: 50,
    skipChangeKinds: [],
    failClosed: true,
  };
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    configPath: ".jevest.yml",
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

  it("throws a clear error if model is missing for a non-none provider (defensive; config validation should already catch this)", () => {
    const config = makeConfig({ provider: "anthropic", model: undefined });
    expect(() => createReviewer(config, makeInputs({ anthropicApiKey: "sk-ant-test" }))).toThrow(
      /reviewer\.model is required/,
    );
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
  });

  it("reads config-path off the local checkout when it exists, without calling the GitHub API", async () => {
    const configPath = join(dir, ".jevest.yml");
    await writeFile(configPath, "budgetUsd: 3\n", "utf8");
    const fetchRepoFileContent = vi.fn();
    const vcs = makeFakeVcs(fetchRepoFileContent);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = await resolveConfig(vcs, REF, configPath);

    expect(config.budgetUsd).toBe(3);
    expect(fetchRepoFileContent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("local checkout"));
    log.mockRestore();
  });

  it("fetches config-path from the PR head sha via the API when it is not on disk", async () => {
    const configPath = join(dir, "does-not-exist.jevest.yml");
    const fetchRepoFileContent = vi.fn().mockResolvedValue("budgetUsd: 7\n");
    const vcs = makeFakeVcs(fetchRepoFileContent);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = await resolveConfig(vcs, REF, configPath);

    expect(config.budgetUsd).toBe(7);
    expect(fetchRepoFileContent).toHaveBeenCalledWith({
      owner: "tincke10",
      repo: "jevest",
      path: configPath,
      ref: "head-sha",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("via the GitHub API"));
    log.mockRestore();
  });

  it("falls back to the built-in defaults, logging one line, when the file is absent both locally and in the repo", async () => {
    const configPath = join(dir, "does-not-exist.jevest.yml");
    const vcs = makeFakeVcs(vi.fn().mockResolvedValue(null));
    const silencedLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const defaults = await resolveConfig(
      makeFakeVcs(vi.fn().mockResolvedValue(null)),
      REF,
      join(dir, "also-does-not-exist.jevest.yml"),
    );
    silencedLog.mockClear();

    const config = await resolveConfig(vcs, REF, configPath);

    expect(config).toEqual(defaults);
    expect(silencedLog).toHaveBeenCalledWith(
      expect.stringContaining("using the built-in defaults"),
    );
    silencedLog.mockRestore();
  });

  it("propagates a non-ENOENT local read error instead of falling through to the API", async () => {
    // `dir` itself is a directory, not a file: readFile on it reliably fails EISDIR, not ENOENT.
    const fetchRepoFileContent = vi.fn();
    const vcs = makeFakeVcs(fetchRepoFileContent);

    await expect(resolveConfig(vcs, REF, dir)).rejects.toThrow();
    expect(fetchRepoFileContent).not.toHaveBeenCalled();
  });
});
