import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ChangeSummaryInput } from "../../domain/ports/change-summarizer-port.js";
import { DEEPSEEK_BASE_URL } from "../reviewers/deepseek-reviewer.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  DEEPSEEK_SUMMARY_SYSTEM_PROMPT,
  type DeepSeekSummaryClient,
  createDeepSeekSummarizer,
} from "./deepseek-summarizer.js";
import { SUMMARY_SYSTEM_PROMPT } from "./summary-prompt.js";

const SAMPLE_INPUT: ChangeSummaryInput = {
  prId: "acme/shop#42",
  files: [
    {
      path: "src/checkout/total.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      patch: "@@ -1,3 +1,6 @@\n-const tax = 0;\n+const tax = subtotal * rate;",
    },
  ],
};

const STRUCTURED = {
  what_changes: "Applies the tax rate to the checkout subtotal.",
  behavior_changes: ["Checkout totals now include tax."],
  user_facing: true,
  breaking: false,
  areas: ["checkout"],
  risks: [],
};

type FakeClient = DeepSeekSummaryClient & {
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

describe("createDeepSeekSummarizer", () => {
  it("maps a successful json_object response to ChangeSummaryOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekSummarizer({ client, now: () => 0 }).summarize(SAMPLE_INPUT);

    expect(output.summary).toEqual({
      whatChanges: STRUCTURED.what_changes,
      behaviorChanges: STRUCTURED.behavior_changes,
      userFacing: true,
      breaking: false,
      areas: ["checkout"],
      risks: [],
    });
    expect(output.model).toBe("deepseek-v4-pro");
    expect(output.requestId).toBe("chatcmpl_ds_01");
  });

  it("splits usage into cache-miss input and cache-hit tokens so cost math never double-counts", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT);
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
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 250 },
        },
      }),
    );
    const output = await createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT);
    expect(output.usage).toEqual({
      inputTokens: 750,
      outputTokens: 50,
      cacheReadInputTokens: 250,
      cacheCreationInputTokens: 0,
    });
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1400);
    const output = await createDeepSeekSummarizer({ client, now }).summarize(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(400);
  });

  it("defaults to deepseek-v4-pro, requests json_object output, caps max_tokens and never sends the PR id", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT);

    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-v4-pro");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.max_tokens).toBe(2048);
    expect(params.messages).toEqual([
      { role: "system", content: DEEPSEEK_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining("src/checkout/total.ts") },
    ]);
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.prId);
  });

  it("system prompt satisfies DeepSeek's json_object contract: the shared prompt, the word json and the shape", () => {
    expect(DEEPSEEK_SUMMARY_SYSTEM_PROMPT.startsWith(SUMMARY_SYSTEM_PROMPT)).toBe(true);
    expect(DEEPSEEK_SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain("json");
    expect(DEEPSEEK_SUMMARY_SYSTEM_PROMPT).toContain('"what_changes"');
    expect(DEEPSEEK_SUMMARY_SYSTEM_PROMPT).toContain('"behavior_changes"');
    expect(DEEPSEEK_SUMMARY_SYSTEM_PROMPT).toContain('"user_facing"');
  });

  it("allows overriding model and maxTokens", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekSummarizer({ client, model: "deepseek-flash", maxTokens: 512 }).summarize(
      SAMPLE_INPUT,
    );
    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-flash");
    expect(params.max_tokens).toBe(512);
  });

  it("throws ReviewerParseError on empty content (documented DeepSeek json-mode failure mode)", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    );
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("throws ReviewerParseError on invalid JSON (e.g. truncated by max_tokens)", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [{ message: { content: '{"what_changes":"x' }, finish_reason: "length" }],
      }),
    );
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("throws ReviewerParseError when the JSON does not match the summary schema", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [{ message: { content: '{"what_changes":42}' }, finish_reason: "stop" }],
      }),
    );
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerAuthenticationError,
    );
  });

  it("wraps any other APIError as ReviewerApiError, naming DeepSeek's 402 insufficient-balance case", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerApiError,
    );

    const { APIError } = await import("openai");
    const broke = fakeClient(async () => {
      throw new APIError(402, {}, "Insufficient Balance", new Headers());
    });
    await expect(
      createDeepSeekSummarizer({ client: broke }).summarize(SAMPLE_INPUT),
    ).rejects.toThrow(/402.*insufficient_balance/);
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    await expect(createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      TypeError,
    );
  });

  describe.skipIf(!process.env.DEEPSEEK_API_KEY)("live", () => {
    it("summarizes a real change against the DeepSeek API", async () => {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: DEEPSEEK_BASE_URL,
      });
      const output = await createDeepSeekSummarizer({ client }).summarize(SAMPLE_INPUT);
      expect(output.summary.whatChanges.length).toBeGreaterThan(0);
      expect(output.usage.inputTokens + output.usage.cacheReadInputTokens).toBeGreaterThan(0);
    });
  });
});
