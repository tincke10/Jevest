import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevestConfig } from "../adapters/config/jevest-config.js";
import type { GitHubVcsAdapter } from "../adapters/vcs/github-vcs-adapter.js";
import { ZERO_WALL_TIMES } from "../application/pipeline/run-metrics.js";
import type { PipelineResult } from "../application/pipeline/run-pipeline.js";
import type { ReviewPublication } from "../domain/ports/vcs-port.js";
import type { PullRequestData, PullRequestRef } from "../domain/pull-request.js";
import type { SpendCapEvaluation } from "../domain/spend-cap.js";
import {
  ActionInputError,
  type ActionInputs,
  buildOutputLines,
  createReviewer,
  createSummarizer,
  loadPullRequestRefFromEvent,
  parseActionInputs,
  pullRequestRefFromEventPayload,
  resolveCalibration,
  resolveConfig,
  resolveProductContext,
  spendCapAnnotations,
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
      INPUT_CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      INPUT_FAIL_ON: "failure",
    });
    expect(inputs).toEqual({
      configPath: "config/jevest.yml",
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

  it("fetches config-path from the PR BASE sha via the API when it is not on disk (never the head: a PR must not rewrite the rules that judge it)", async () => {
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
      ref: "base-sha",
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
    publication,
    check: publication.check,
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
          skipped: {
            triageSkip: 0,
            skipChangeKind: 1,
            secret: 1,
            budget: 1,
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
  it("emits the eight outputs, with spend-usd as the cumulative total after this run and the H2 / H4 numbers", () => {
    expect(buildOutputLines(makeResult({ spendCap: evaluation() }))).toBe(
      "check-conclusion=success\nfindings-published=2\nfindings-low-confidence=3\ncost-usd=0.1234\nspend-usd=12.5\n" +
        "jev-latency-p95-ms=400\njev-requests=6\nllm-tokens-saved-pct=30.5\n",
    );
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
