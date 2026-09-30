import { APIError, AuthenticationError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
  type DeepSeekDescriptionContextClient,
  createDeepSeekDescriptionContextExtractor,
} from "./deepseek-description-context-extractor.js";
import { DESCRIPTION_CONTEXT_SYSTEM_PROMPT } from "./description-context-prompt.js";
import {
  SAMPLE_EXTRACTION,
  SAMPLE_DESCRIPTION_CONTEXT_INPUT as SAMPLE_INPUT,
} from "./description-context-test-fixtures.js";

type FakeClient = DeepSeekDescriptionContextClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(createImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { create: vi.fn(createImpl) } } } as unknown as FakeClient;
}

function successResponse(content: string | null = JSON.stringify(SAMPLE_EXTRACTION)) {
  return {
    id: "chatcmpl_ds_ctx",
    model: "deepseek-v4-pro",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 80,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 600,
    },
  };
}

describe("createDeepSeekDescriptionContextExtractor", () => {
  it("maps a json_object reply to DescriptionContextOutput, splitting cache hit and miss tokens", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekDescriptionContextExtractor({
      client,
      now: () => 0,
    }).extract(SAMPLE_INPUT);
    expect(output.context.decisions).toEqual(SAMPLE_EXTRACTION.decisions);
    expect(output.discarded).toEqual(SAMPLE_EXTRACTION.discarded);
    expect(output.usage).toEqual({
      inputTokens: 600,
      outputTokens: 80,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    });
  });

  it("asks for json_object with a prompt that names json and every field", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekDescriptionContextExtractor({ client }).extract(SAMPLE_INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages[0].content).toBe(DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT);
    expect(
      DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT.startsWith(DESCRIPTION_CONTEXT_SYSTEM_PROMPT),
    ).toBe(true);
    expect(DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT.toLowerCase()).toContain("json");
    for (const field of Object.keys(SAMPLE_EXTRACTION)) {
      expect(DEEPSEEK_DESCRIPTION_CONTEXT_SYSTEM_PROMPT).toContain(`"${field}"`);
    }
  });

  it("throws ReviewerParseError on empty content, invalid JSON or a schema miss", async () => {
    for (const content of [null, "", "{not json", JSON.stringify({ decisions: [] })]) {
      const client = fakeClient(async () => successResponse(content));
      await expect(
        createDeepSeekDescriptionContextExtractor({ client }).extract(SAMPLE_INPUT),
      ).rejects.toThrow(ReviewerParseError);
    }
  });

  it("maps SDK errors onto the shared reviewer taxonomy, 402 as insufficient balance", async () => {
    const throwing = (error: Error) =>
      createDeepSeekDescriptionContextExtractor({
        client: fakeClient(async () => {
          throw error;
        }),
      }).extract(SAMPLE_INPUT);
    await expect(throwing(new RateLimitError(429, {}, "rl", new Headers()))).rejects.toThrow(
      ReviewerRateLimitError,
    );
    await expect(throwing(new AuthenticationError(401, {}, "bad", new Headers()))).rejects.toThrow(
      ReviewerAuthenticationError,
    );
    await expect(
      throwing(APIError.generate(402, {}, "Insufficient Balance", new Headers())),
    ).rejects.toThrow(/insufficient_balance/);
    await expect(throwing(APIError.generate(500, {}, "down", new Headers()))).rejects.toThrow(
      ReviewerApiError,
    );
  });
});
