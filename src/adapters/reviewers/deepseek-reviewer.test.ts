import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_SYSTEM_PROMPT,
  type DeepSeekChatClient,
  buildDeepSeekSystemPrompt,
  createDeepSeekReviewer,
} from "./deepseek-reviewer.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "./reviewer-errors.js";

const SAMPLE_INPUT: ReviewInput = {
  hunkId: "zod-9446b5c-1",
  file: "packages/zod/src/v4/core/compile.ts",
  language: "typescript",
  hunkHeader: "@@ -1268,13 +1268,13 @@ function generateObjectCheck(",
  before: "const outputVar = newVar(ctx);",
  diff: "@@ -1268,13 +1268,13 @@\n-const outputVar = newVar(ctx);\n+const outputVar = newVar(ctx2);",
};

type FakeClient = DeepSeekChatClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(createImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { create: vi.fn(createImpl) } } } as unknown as FakeClient;
}

const ONE_FINDING = {
  findings: [
    {
      line_start: 1270,
      line_end: 1270,
      claim: "off-by-one in the bound check",
      rationale: "the comparison should be strict",
      suggested_severity: "major",
    },
  ],
};

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_ds_01",
    model: "deepseek-v4-pro",
    choices: [{ message: { content: JSON.stringify(ONE_FINDING) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1100,
      completion_tokens: 90,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 700,
    },
    ...overrides,
  };
}

describe("createDeepSeekReviewer", () => {
  it("exposes the OpenAI-compatible base URL callers must configure the client with", () => {
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
  });

  it("maps a successful json_object response to ReviewOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createDeepSeekReviewer({ client, now: () => 0 });

    const output = await reviewer.review(SAMPLE_INPUT);

    expect(output.findings).toEqual([
      {
        lineStart: 1270,
        lineEnd: 1270,
        claim: "off-by-one in the bound check",
        rationale: "the comparison should be strict",
        suggestedSeverity: "major",
      },
    ]);
    expect(output.model).toBe("deepseek-v4-pro");
    expect(output.requestId).toBe("chatcmpl_ds_01");
  });

  it("splits usage into cache-miss input and cache-hit tokens so cost math never double-counts", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createDeepSeekReviewer({ client });

    const output = await reviewer.review(SAMPLE_INPUT);

    expect(output.usage).toEqual({
      inputTokens: 700,
      outputTokens: 90,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    });
  });

  it("falls back to prompt_tokens minus prompt_tokens_details.cached_tokens when DeepSeek's cache fields are absent", async () => {
    const client = fakeClient(async () =>
      successResponse({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 250 },
        },
      }),
    );
    const reviewer = createDeepSeekReviewer({ client });

    const output = await reviewer.review(SAMPLE_INPUT);

    expect(output.usage).toEqual({
      inputTokens: 750,
      outputTokens: 50,
      cacheReadInputTokens: 250,
      cacheCreationInputTokens: 0,
    });
  });

  it("returns an empty findings array without forcing a finding", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [{ message: { content: '{"findings":[]}' }, finish_reason: "stop" }],
      }),
    );
    const reviewer = createDeepSeekReviewer({ client });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.findings).toEqual([]);
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1400);
    const reviewer = createDeepSeekReviewer({ client, now });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(400);
  });

  it("defaults to deepseek-v4-pro, requests json_object output and caps max_tokens", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createDeepSeekReviewer({ client });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-v4-pro");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.max_tokens).toBe(4096);
    expect(params.messages).toEqual([
      { role: "system", content: DEEPSEEK_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining(SAMPLE_INPUT.file) },
    ]);
  });

  it("honors a systemPrompt override, still appending DeepSeek's json_object rules", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekReviewer({ client, systemPrompt: "custom prompt" }).review(SAMPLE_INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    const system = params.messages[0].content as string;
    expect(system.startsWith("custom prompt")).toBe(true);
    expect(system).toBe(buildDeepSeekSystemPrompt("custom prompt"));
    expect(system.toLowerCase()).toContain("json");
    expect(system).toContain('"suggested_severity"');
  });

  it("system prompt satisfies DeepSeek's json_object contract: mentions json and shows the shape", () => {
    // Per https://api-docs.deepseek.com/guides/json_mode: the prompt must
    // contain the word "json" and an example of the expected object.
    expect(DEEPSEEK_SYSTEM_PROMPT.toLowerCase()).toContain("json");
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('"findings"');
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('"suggested_severity"');
  });

  it("allows overriding model and maxTokens", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createDeepSeekReviewer({ client, model: "deepseek-flash", maxTokens: 2048 });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-flash");
    expect(params.max_tokens).toBe(2048);
  });

  it("throws ReviewerParseError on empty content (documented DeepSeek json-mode failure mode)", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    );
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerParseError);
  });

  it("throws ReviewerParseError on invalid JSON (e.g. truncated by max_tokens)", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [
          { message: { content: '{"findings":[{"line_start":1' }, finish_reason: "length" },
        ],
      }),
    );
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerParseError);
  });

  it("throws ReviewerParseError when the JSON does not match the review schema", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [
          {
            message: { content: '{"findings":[{"claim":"x","suggested_severity":"huge"}]}' },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerParseError);
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerRateLimitError);
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerAuthenticationError);
  });

  it("wraps any other APIError as ReviewerApiError, naming DeepSeek's 402 insufficient-balance case", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    await expect(createDeepSeekReviewer({ client }).review(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerApiError,
    );

    const { APIError } = await import("openai");
    const broke = fakeClient(async () => {
      throw new APIError(402, {}, "Insufficient Balance", new Headers());
    });
    await expect(createDeepSeekReviewer({ client: broke }).review(SAMPLE_INPUT)).rejects.toThrow(
      /402.*insufficient_balance/,
    );
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    const reviewer = createDeepSeekReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(TypeError);
  });

  describe.skipIf(!process.env.DEEPSEEK_API_KEY)("live", () => {
    it("reviews a real hunk against the DeepSeek API", async () => {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: DEEPSEEK_BASE_URL,
      });
      const reviewer = createDeepSeekReviewer({ client });

      const output = await reviewer.review(SAMPLE_INPUT);
      expect(Array.isArray(output.findings)).toBe(true);
      expect(output.usage.inputTokens + output.usage.cacheReadInputTokens).toBeGreaterThan(0);
    });
  });
});
