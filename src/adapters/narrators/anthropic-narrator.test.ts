import { AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { type AnthropicNarrativeClient, createAnthropicNarrator } from "./anthropic-narrator.js";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative-prompt.js";
import {
  SAMPLE_NARRATIVE_INPUT as SAMPLE_INPUT,
  SAMPLE_REVIEW_MARKDOWN,
} from "./narrative-test-fixtures.js";

type FakeClient = AnthropicNarrativeClient & { messages: { parse: ReturnType<typeof vi.fn> } };

function fakeClient(parseImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { messages: { parse: vi.fn(parseImpl) } } as unknown as FakeClient;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_narr",
    model: "claude-sonnet-5",
    parsed_output: { review: SAMPLE_REVIEW_MARKDOWN },
    usage: {
      input_tokens: 2400,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  };
}

describe("createAnthropicNarrator", () => {
  it("maps a successful structured-output response to ReviewNarrativeOutput", async () => {
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1600);
    const client = fakeClient(async () => successResponse());
    const output = await createAnthropicNarrator({ client, now }).narrate(SAMPLE_INPUT);

    expect(output.markdown).toBe(SAMPLE_REVIEW_MARKDOWN);
    expect(output.model).toBe("claude-sonnet-5");
    expect(output.usage).toEqual({
      inputTokens: 2400,
      outputTokens: 300,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 0,
    });
    expect(output.latencyMs).toBe(600);
    expect(output.requestId).toBe("msg_narr");
    expect(output.nominalCostUsd).toBeUndefined();
  });

  it("sends the cached narrative system prompt, one user turn, effort medium, and no pr id", async () => {
    const client = fakeClient(async () => successResponse());
    await createAnthropicNarrator({ client, model: "claude-opus-5" }).narrate(SAMPLE_INPUT);

    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params).toMatchObject({ model: "claude-opus-5", output_config: { effort: "medium" } });
    expect(params.system).toEqual([
      { type: "text", text: NARRATIVE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].content).toContain("Write the review in: es");
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.prId);
  });

  it("throws ReviewerParseError when parsed_output is null", async () => {
    const client = fakeClient(async () => successResponse({ parsed_output: null }));
    await expect(createAnthropicNarrator({ client }).narrate(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("maps SDK errors onto the shared reviewer taxonomy", async () => {
    const throwing = (error: Error) =>
      createAnthropicNarrator({
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
    await expect(throwing(new TypeError("boom"))).rejects.toThrow(TypeError);
  });
});
