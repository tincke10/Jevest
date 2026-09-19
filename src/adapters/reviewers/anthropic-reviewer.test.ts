import { AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import { type AnthropicMessagesClient, createAnthropicReviewer } from "./anthropic-reviewer.js";
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

function fakeClient(
  parseImpl: (params: unknown) => Promise<unknown>,
): AnthropicMessagesClient & { messages: { parse: ReturnType<typeof vi.fn> } } {
  return { messages: { parse: vi.fn(parseImpl) } } as unknown as AnthropicMessagesClient & {
    messages: { parse: ReturnType<typeof vi.fn> };
  };
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01abc",
    model: "claude-opus-5",
    parsed_output: {
      findings: [
        {
          line_start: 1270,
          line_end: 1270,
          claim: "off-by-one in the bound check",
          rationale: "the comparison should be strict",
          suggested_severity: "major",
        },
      ],
    },
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

describe("createAnthropicReviewer", () => {
  it("maps a successful structured-output response to ReviewOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createAnthropicReviewer({ client, now: () => 0 });

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
    expect(output.model).toBe("claude-opus-5");
    expect(output.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("msg_01abc");
  });

  it("returns an empty findings array without forcing a finding", async () => {
    const client = fakeClient(async () => successResponse({ parsed_output: { findings: [] } }));
    const reviewer = createAnthropicReviewer({ client });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.findings).toEqual([]);
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1250);
    const reviewer = createAnthropicReviewer({ client, now });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(250);
  });

  it("defaults to model claude-opus-5, effort medium, and a cached system prompt", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createAnthropicReviewer({ client });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params).toMatchObject({
      model: "claude-opus-5",
      output_config: { effort: "medium" },
    });
    expect(params.system).toEqual([
      expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } }),
    ]);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain(SAMPLE_INPUT.file);
    expect(params.messages[0].content).toContain(SAMPLE_INPUT.hunkHeader);
  });

  it("never sends budget_tokens or an assistant prefill message", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createAnthropicReviewer({ client });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params.thinking).toBeUndefined();
    expect(params.messages.some((m: { role: string }) => m.role === "assistant")).toBe(false);
  });

  it("allows overriding model, effort, and maxTokens", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createAnthropicReviewer({
      client,
      model: "claude-sonnet-5",
      effort: "high",
      maxTokens: 2048,
    });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.output_config.effort).toBe("high");
    expect(params.max_tokens).toBe(2048);
  });

  it("throws ReviewerParseError when parsed_output is null", async () => {
    const client = fakeClient(async () => successResponse({ parsed_output: null }));
    const reviewer = createAnthropicReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerParseError);
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    const reviewer = createAnthropicReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerRateLimitError);
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    const reviewer = createAnthropicReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerAuthenticationError);
  });

  it("wraps any other APIError as ReviewerApiError", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    const reviewer = createAnthropicReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerApiError);
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    const reviewer = createAnthropicReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(TypeError);
  });

  describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live", () => {
    it("reviews a real hunk against the Anthropic API", async () => {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();
      const reviewer = createAnthropicReviewer({ client });

      const output = await reviewer.review(SAMPLE_INPUT);
      expect(Array.isArray(output.findings)).toBe(true);
      expect(output.usage.inputTokens).toBeGreaterThan(0);
    });
  });
});
