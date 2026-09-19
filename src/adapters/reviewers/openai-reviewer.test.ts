import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import { type OpenAiChatClient, createOpenAiReviewer } from "./openai-reviewer.js";
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
): OpenAiChatClient & { chat: { completions: { parse: ReturnType<typeof vi.fn> } } } {
  return { chat: { completions: { parse: vi.fn(parseImpl) } } } as unknown as OpenAiChatClient & {
    chat: { completions: { parse: ReturnType<typeof vi.fn> } };
  };
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_01abc",
    model: "gpt-5.6-luna",
    choices: [
      {
        message: {
          parsed: {
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
        },
      },
    ],
    usage: {
      prompt_tokens: 1100,
      completion_tokens: 90,
      prompt_tokens_details: { cached_tokens: 400 },
    },
    ...overrides,
  };
}

describe("createOpenAiReviewer", () => {
  it("maps a successful structured-output response to ReviewOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createOpenAiReviewer({ client, now: () => 0 });

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
    expect(output.model).toBe("gpt-5.6-luna");
    expect(output.usage).toEqual({
      inputTokens: 1100,
      outputTokens: 90,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("chatcmpl_01abc");
  });

  it("returns an empty findings array without forcing a finding", async () => {
    const client = fakeClient(async () =>
      successResponse({
        choices: [{ message: { parsed: { findings: [] } } }],
      }),
    );
    const reviewer = createOpenAiReviewer({ client });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.findings).toEqual([]);
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1400);
    const reviewer = createOpenAiReviewer({ client, now });

    const output = await reviewer.review(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(400);
  });

  it("defaults to model gpt-5.6-luna and includes the system and user messages", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createOpenAiReviewer({ client });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.model).toBe("gpt-5.6-luna");
    expect(params.messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: expect.stringContaining(SAMPLE_INPUT.file) },
    ]);
  });

  it("allows overriding the model", async () => {
    const client = fakeClient(async () => successResponse());
    const reviewer = createOpenAiReviewer({ client, model: "gpt-5.5" });

    await reviewer.review(SAMPLE_INPUT);

    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.model).toBe("gpt-5.5");
  });

  it("throws ReviewerParseError when no parsed message is returned", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { parsed: null } }] }),
    );
    const reviewer = createOpenAiReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerParseError);
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    const reviewer = createOpenAiReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerRateLimitError);
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    const reviewer = createOpenAiReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerAuthenticationError);
  });

  it("wraps any other APIError as ReviewerApiError", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    const reviewer = createOpenAiReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(ReviewerApiError);
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    const reviewer = createOpenAiReviewer({ client });

    await expect(reviewer.review(SAMPLE_INPUT)).rejects.toThrow(TypeError);
  });

  describe.skipIf(!process.env.OPENAI_API_KEY)("live", () => {
    it("reviews a real hunk against the OpenAI API", async () => {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();
      const reviewer = createOpenAiReviewer({ client });

      const output = await reviewer.review(SAMPLE_INPUT);
      expect(Array.isArray(output.findings)).toBe(true);
      expect(output.usage.inputTokens).toBeGreaterThan(0);
    });
  });
});
