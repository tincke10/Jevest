import { AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  type AnthropicDescriptionContextClient,
  createAnthropicDescriptionContextExtractor,
} from "./anthropic-description-context-extractor.js";
import { DESCRIPTION_CONTEXT_SYSTEM_PROMPT } from "./description-context-prompt.js";
import {
  SAMPLE_EXTRACTION,
  SAMPLE_DESCRIPTION_CONTEXT_INPUT as SAMPLE_INPUT,
} from "./description-context-test-fixtures.js";

type FakeClient = AnthropicDescriptionContextClient & {
  messages: { parse: ReturnType<typeof vi.fn> };
};

function fakeClient(parseImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { messages: { parse: vi.fn(parseImpl) } } as unknown as FakeClient;
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_ctx",
    model: "claude-sonnet-5",
    parsed_output: SAMPLE_EXTRACTION,
    usage: {
      input_tokens: 900,
      output_tokens: 120,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  };
}

describe("createAnthropicDescriptionContextExtractor", () => {
  it("maps a successful structured-output response to DescriptionContextOutput", async () => {
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1400);
    const client = fakeClient(async () => successResponse());
    const output = await createAnthropicDescriptionContextExtractor({ client, now }).extract(
      SAMPLE_INPUT,
    );
    expect(output.context.decisions).toEqual(SAMPLE_EXTRACTION.decisions);
    expect(output.discarded).toEqual(SAMPLE_EXTRACTION.discarded);
    expect(output.model).toBe("claude-sonnet-5");
    expect(output.usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 0,
    });
    expect(output.latencyMs).toBe(400);
    expect(output.requestId).toBe("msg_ctx");
    expect(output.nominalCostUsd).toBeUndefined();
  });

  it("sends the cached extractor system prompt, one user turn, and no PR id", async () => {
    const client = fakeClient(async () => successResponse());
    await createAnthropicDescriptionContextExtractor({ client, model: "claude-opus-5" }).extract(
      SAMPLE_INPUT,
    );
    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params).toMatchObject({ model: "claude-opus-5", output_config: { effort: "low" } });
    expect(params.system).toEqual([
      {
        type: "text",
        text: DESCRIPTION_CONTEXT_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(params.messages).toHaveLength(1);
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.prId);
  });

  it("throws ReviewerParseError when parsed_output is null", async () => {
    const client = fakeClient(async () => successResponse({ parsed_output: null }));
    await expect(
      createAnthropicDescriptionContextExtractor({ client }).extract(SAMPLE_INPUT),
    ).rejects.toThrow(ReviewerParseError);
  });

  it("maps SDK errors onto the shared reviewer taxonomy", async () => {
    const throwing = (error: Error) =>
      createAnthropicDescriptionContextExtractor({
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
    await expect(throwing(new TypeError("boom"))).rejects.toThrow(TypeError);
  });
});
