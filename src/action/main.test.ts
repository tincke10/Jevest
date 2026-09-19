import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ActionInputError,
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
