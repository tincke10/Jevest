import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { DESCRIPTION_CONTEXT_SYSTEM_PROMPT } from "./description-context-prompt.js";
import {
  SAMPLE_EXTRACTION,
  SAMPLE_DESCRIPTION_CONTEXT_INPUT as SAMPLE_INPUT,
} from "./description-context-test-fixtures.js";
import {
  type OpenAiDescriptionContextClient,
  createOpenAiDescriptionContextExtractor,
} from "./openai-description-context-extractor.js";

type FakeClient = OpenAiDescriptionContextClient & {
  chat: { completions: { parse: ReturnType<typeof vi.fn> } };
};

function fakeClient(parseImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { parse: vi.fn(parseImpl) } } } as unknown as FakeClient;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_ctx",
    model: "gpt-5.6-luna",
    choices: [{ message: { parsed: SAMPLE_EXTRACTION } }],
    usage: {
      prompt_tokens: 800,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 300 },
    },
    ...overrides,
  };
}

describe("createOpenAiDescriptionContextExtractor", () => {
  it("maps a successful structured-output response to DescriptionContextOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createOpenAiDescriptionContextExtractor({ client, now: () => 0 }).extract(
      SAMPLE_INPUT,
    );
    expect(output.context.decisions).toEqual(SAMPLE_EXTRACTION.decisions);
    expect(output.discarded).toEqual(SAMPLE_EXTRACTION.discarded);
    expect(output.usage).toEqual({
      inputTokens: 800,
      outputTokens: 100,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("chatcmpl_ctx");
  });

  it("sends the extractor system prompt and a user turn without the PR id", async () => {
    const client = fakeClient(async () => successResponse());
    await createOpenAiDescriptionContextExtractor({ client }).extract(SAMPLE_INPUT);
    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.messages[0]).toEqual({
      role: "system",
      content: DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
    });
    expect(JSON.stringify(params.messages)).not.toContain(SAMPLE_INPUT.prId);
  });

  it("throws ReviewerParseError when nothing was parsed", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { parsed: null } }] }),
    );
    await expect(
      createOpenAiDescriptionContextExtractor({ client }).extract(SAMPLE_INPUT),
    ).rejects.toThrow(ReviewerParseError);
  });

  it("maps SDK errors onto the shared reviewer taxonomy", async () => {
    const throwing = (error: Error) =>
      createOpenAiDescriptionContextExtractor({
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
    await expect(throwing(new BadRequestError(400, {}, "bad", new Headers()))).rejects.toThrow(
      ReviewerApiError,
    );
  });
});
