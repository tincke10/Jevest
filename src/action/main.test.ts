import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JevestConfig } from "../adapters/config/jevest-config.js";
import {
  ActionInputError,
  type ActionInputs,
  createReviewer,
  loadPullRequestRefFromEvent,
  parseActionInputs,
  pullRequestRefFromEventPayload,
} from "./main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "../../tests/fixtures/github/pull_request.event.json");

const BASE_ENV: NodeJS.ProcessEnv = {
  "INPUT_GITHUB-TOKEN": "ghp_test",
  "INPUT_TYPESAFE-API-KEY": "ts_test",
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
      "INPUT_CONFIG-PATH": "config/jevest.yml",
      "INPUT_ANTHROPIC-API-KEY": "sk-ant-test",
      "INPUT_OPENAI-API-KEY": "sk-oai-test",
      "INPUT_FAIL-ON": "failure",
    });
    expect(inputs).toEqual({
      configPath: "config/jevest.yml",
      typesafeApiKey: "ts_test",
      anthropicApiKey: "sk-ant-test",
      openaiApiKey: "sk-oai-test",
      githubToken: "ghp_test",
      failOn: "failure",
    });
  });

  it("throws when github-token is missing", () => {
    const { "INPUT_GITHUB-TOKEN": _omit, ...rest } = BASE_ENV;
    expect(() => parseActionInputs(rest)).toThrow(ActionInputError);
  });

  it("throws when typesafe-api-key is missing", () => {
    const { "INPUT_TYPESAFE-API-KEY": _omit, ...rest } = BASE_ENV;
    expect(() => parseActionInputs(rest)).toThrow(ActionInputError);
  });

  it("throws on an invalid fail-on value", () => {
    expect(() => parseActionInputs({ ...BASE_ENV, "INPUT_FAIL-ON": "always" })).toThrow(
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
