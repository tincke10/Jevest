import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative-prompt.js";
import {
  SAMPLE_NARRATIVE_INPUT as SAMPLE_INPUT,
  SAMPLE_REVIEW_MARKDOWN,
} from "./narrative-test-fixtures.js";
import { type OpenAiNarrativeClient, createOpenAiNarrator } from "./openai-narrator.js";

type FakeClient = OpenAiNarrativeClient & {
  chat: { completions: { parse: ReturnType<typeof vi.fn> } };
};

function fakeClient(parseImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { parse: vi.fn(parseImpl) } } } as unknown as FakeClient;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_narr",
    model: "gpt-5.6-luna",
    choices: [{ message: { parsed: { review: SAMPLE_REVIEW_MARKDOWN } } }],
    usage: {
      prompt_tokens: 2000,
      completion_tokens: 250,
      prompt_tokens_details: { cached_tokens: 500 },
    },
    ...overrides,
  };
}

describe("createOpenAiNarrator", () => {
  it("maps a successful structured-output response to ReviewNarrativeOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createOpenAiNarrator({ client, now: () => 0 }).narrate(SAMPLE_INPUT);

    expect(output.markdown).toBe(SAMPLE_REVIEW_MARKDOWN);
    expect(output.model).toBe("gpt-5.6-luna");
    expect(output.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 250,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("chatcmpl_narr");
  });

  it("sends the narrative system prompt and the per-PR user message", async () => {
    const client = fakeClient(async () => successResponse());
    await createOpenAiNarrator({ client, model: "gpt-x" }).narrate(SAMPLE_INPUT);
    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.model).toBe("gpt-x");
    expect(params.messages[0]).toEqual({ role: "system", content: NARRATIVE_SYSTEM_PROMPT });
    expect(params.messages[1].content).toContain("Verdict to state at the end: needs changes");
  });

  it("throws ReviewerParseError when parsed is null", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { parsed: null } }] }),
    );
    await expect(createOpenAiNarrator({ client }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("maps SDK errors onto the shared reviewer taxonomy", async () => {
    const throwing = (error: Error) =>
      createOpenAiNarrator({
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
    await expect(throwing(new BadRequestError(400, {}, "bad", new Headers()))).rejects.toThrow(
      ReviewerApiError,
    );
  });
});
