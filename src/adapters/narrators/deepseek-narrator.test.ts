import { APIError, AuthenticationError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  DEEPSEEK_NARRATIVE_SYSTEM_PROMPT,
  type DeepSeekNarrativeClient,
  createDeepSeekNarrator,
} from "./deepseek-narrator.js";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative-prompt.js";
import {
  SAMPLE_NARRATIVE_INPUT as SAMPLE_INPUT,
  SAMPLE_REVIEW_MARKDOWN,
} from "./narrative-test-fixtures.js";

type FakeClient = DeepSeekNarrativeClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(createImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { create: vi.fn(createImpl) } } } as unknown as FakeClient;
}

function successResponse(
  content: string | null = JSON.stringify({ review: SAMPLE_REVIEW_MARKDOWN }),
) {
  return {
    id: "chatcmpl_ds_narr",
    model: "deepseek-v4-pro",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 2100,
      completion_tokens: 260,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 1200,
    },
  };
}

describe("createDeepSeekNarrator", () => {
  it("maps a json_object reply to ReviewNarrativeOutput, splitting cache hit and miss tokens", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createDeepSeekNarrator({ client, now: () => 0 }).narrate(SAMPLE_INPUT);

    expect(output.markdown).toBe(SAMPLE_REVIEW_MARKDOWN);
    expect(output.model).toBe("deepseek-v4-pro");
    expect(output.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 260,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
  });

  it("asks for json_object with a prompt that names json and the review field", async () => {
    const client = fakeClient(async () => successResponse());
    await createDeepSeekNarrator({ client }).narrate(SAMPLE_INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages[0].content).toBe(DEEPSEEK_NARRATIVE_SYSTEM_PROMPT);
    expect(DEEPSEEK_NARRATIVE_SYSTEM_PROMPT.startsWith(NARRATIVE_SYSTEM_PROMPT)).toBe(true);
    expect(DEEPSEEK_NARRATIVE_SYSTEM_PROMPT.toLowerCase()).toContain("json");
    expect(DEEPSEEK_NARRATIVE_SYSTEM_PROMPT).toContain('"review"');
  });

  it("throws ReviewerParseError on empty content, invalid JSON or a schema miss", async () => {
    for (const content of [null, "", "{not json", JSON.stringify({ review: "" })]) {
      const client = fakeClient(async () => successResponse(content));
      await expect(createDeepSeekNarrator({ client }).narrate(SAMPLE_INPUT)).rejects.toThrow(
        ReviewerParseError,
      );
    }
  });

  it("maps SDK errors onto the shared reviewer taxonomy, 402 as insufficient balance", async () => {
    const throwing = (error: Error) =>
      createDeepSeekNarrator({
        client: fakeClient(async () => {
          throw error;
        }),
      }).narrate(SAMPLE_INPUT);
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
