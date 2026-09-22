import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { FindingJudgeInput } from "../../domain/ports/finding-judge-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  DEEPSEEK_JUDGE_SYSTEM_PROMPT,
  type DeepSeekJudgeChatClient,
  createDeepSeekFindingJudge,
} from "./deepseek-finding-judge.js";
import { JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";

const SAMPLE_INPUT: FindingJudgeInput = {
  findingId: "zod-9446b5c-1::claude-cli::0",
  hunkDiff:
    "@@ -1268,3 +1268,3 @@\n-const outputVar = newVar(ctx);\n+const outputVar = newVar(ctx2);",
  file: "packages/zod/src/v4/core/compile.ts",
  lineStart: 1268,
  lineEnd: 1268,
  claim: "The wrong context is passed to newVar.",
  rationale: "ctx is the outer context; the inner one is ctx2.",
};

const STRUCTURED = {
  is_real_defect_probability: 0.85,
  severity: "major",
  is_style_only: false,
  actionable: true,
};

type FakeClient = DeepSeekJudgeChatClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(createImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { create: vi.fn(createImpl) } } } as unknown as FakeClient;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_ds_01",
    model: "deepseek-v4-pro",
    choices: [{ message: { content: JSON.stringify(STRUCTURED) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1100,
      completion_tokens: 90,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 700,
    },
    ...overrides,
  };
}

describe("createDeepSeekFindingJudge", () => {
  it("maps a successful json_object response to FindingJudgeOutput with the DeepSeek model and no nominal cost", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);

    expect(output.judgment).toEqual({
      isRealDefectProb: 0.85,
      severity: "major",
      isStyleOnly: false,
      actionable: true,
    });
    expect(output.model).toBe("deepseek-v4-pro");
    expect(output.requestId).toBe("chatcmpl_ds_01");
    expect(output.nominalCostUsd).toBeUndefined();
    expect(output.sessionId).toBeUndefined();
  });

  it("splits usage into cache-miss input and cache-hit tokens so cost math never double-counts", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);
    expect(output.usage).toEqual({
      inputTokens: 700,
      outputTokens: 90,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    });
  });

  it("falls back to prompt_tokens minus cached_tokens when DeepSeek's cache fields are absent", async () => {
    const client = fakeClient(async () =>
      successResponse({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 250 },
        },
      }),
    );
    const output = await createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);
    expect(output.usage.inputTokens).toBe(750);
    expect(output.usage.cacheReadInputTokens).toBe(250);
  });

  it("defaults to deepseek-v4-pro, json_object output, max_tokens 8192 (reasoning tokens count against it), and sends the judge prompt with the JSON shape", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);

    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-v4-pro");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.max_tokens).toBe(8192);
    expect(params.messages).toEqual([
      { role: "system", content: DEEPSEEK_JUDGE_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining(SAMPLE_INPUT.claim) },
    ]);
    expect(params.messages[1].content).toContain(SAMPLE_INPUT.hunkDiff);
    expect(params.messages[1].content).toContain(SAMPLE_INPUT.rationale);
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.findingId);
  });

  it("system prompt starts with the shared judge prompt and satisfies DeepSeek's json_object contract", () => {
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT.startsWith(JUDGE_SYSTEM_PROMPT)).toBe(true);
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("json");
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT).toContain('"is_real_defect_probability"');
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT).toContain('"severity"');
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT).toContain('"is_style_only"');
    expect(DEEPSEEK_JUDGE_SYSTEM_PROMPT).toContain('"actionable"');
  });

  it("allows overriding model and maxTokens", async () => {
    const client = fakeClient(async () => successResponse({ model: "deepseek-flash" }));
    const output = await createDeepSeekFindingJudge({
      client,
      model: "deepseek-flash",
      maxTokens: 256,
    }).judge(SAMPLE_INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-flash");
    expect(params.max_tokens).toBe(256);
    expect(output.model).toBe("deepseek-flash");
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1350);
    const output = await createDeepSeekFindingJudge({ client, now }).judge(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(350);
  });

  it("throws ReviewerParseError on empty content", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    );
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("throws ReviewerParseError naming the truncation when finish_reason is length (reasoning ate max_tokens)", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [
          { message: { content: '{"is_real_defect_probability": 0.' }, finish_reason: "length" },
        ],
      }),
    );
    const promise = createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);
    await expect(promise).rejects.toThrow(ReviewerParseError);
    await expect(promise).rejects.toThrow(/truncated at max_tokens=8192 \(finish_reason=length\)/);
  });

  it("throws ReviewerParseError on invalid JSON with finish_reason stop, without a truncation note", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { content: "not json" }, finish_reason: "stop" }] }),
    );
    const promise = createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT);
    await expect(promise).rejects.toThrow(ReviewerParseError);
    await expect(promise).rejects.not.toThrow(/truncated/);
  });

  it("throws ReviewerParseError when the JSON does not match the judge schema (probability out of range)", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [
          {
            message: { content: JSON.stringify({ ...STRUCTURED, is_real_defect_probability: 7 }) },
            finish_reason: "stop",
          },
        ],
      }),
    );
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerAuthenticationError,
    );
  });

  it("wraps any other APIError as ReviewerApiError, naming DeepSeek's 402 insufficient-balance case", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerApiError,
    );

    const { APIError } = await import("openai");
    const broke = fakeClient(async () => {
      throw new APIError(402, {}, "Insufficient Balance", new Headers());
    });
    await expect(createDeepSeekFindingJudge({ client: broke }).judge(SAMPLE_INPUT)).rejects.toThrow(
      /402.*insufficient_balance/,
    );
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    await expect(createDeepSeekFindingJudge({ client }).judge(SAMPLE_INPUT)).rejects.toThrow(
      TypeError,
    );
  });
});
