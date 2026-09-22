import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ChangeSummaryInput } from "../../domain/ports/change-summarizer-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { type OpenAiSummaryClient, createOpenAiSummarizer } from "./openai-summarizer.js";
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

function fakeClient(
  parseImpl: (params: unknown) => Promise<unknown>,
): OpenAiSummaryClient & { chat: { completions: { parse: ReturnType<typeof vi.fn> } } } {
  return {
    chat: { completions: { parse: vi.fn(parseImpl) } },
  } as unknown as OpenAiSummaryClient & {
    chat: { completions: { parse: ReturnType<typeof vi.fn> } };
  };
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_01abc",
    model: "gpt-5.6-luna",
    choices: [{ message: { parsed: STRUCTURED } }],
    usage: {
      prompt_tokens: 1100,
      completion_tokens: 90,
      prompt_tokens_details: { cached_tokens: 400 },
    },
    ...overrides,
  };
}

describe("createOpenAiSummarizer", () => {
  it("maps a successful structured-output response to ChangeSummaryOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const output = await createOpenAiSummarizer({ client, now: () => 0 }).summarize(SAMPLE_INPUT);

    expect(output.summary).toEqual({
      whatChanges: STRUCTURED.what_changes,
      behaviorChanges: STRUCTURED.behavior_changes,
      userFacing: true,
      breaking: false,
      areas: ["checkout"],
      risks: [],
    });
    expect(output.model).toBe("gpt-5.6-luna");
    expect(output.usage).toEqual({
      inputTokens: 1100,
      outputTokens: 90,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("chatcmpl_01abc");
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1400);
    const output = await createOpenAiSummarizer({ client, now }).summarize(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(400);
  });

  it("defaults to model gpt-5.6-luna with the summary system prompt and a files-only user message", async () => {
    const client = fakeClient(async () => successResponse());
    await createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT);

    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.model).toBe("gpt-5.6-luna");
    expect(params.messages).toEqual([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining("src/checkout/total.ts") },
    ]);
    expect(params.response_format.type).toBe("json_schema");
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.prId);
  });

  it("allows overriding the model", async () => {
    const client = fakeClient(async () => successResponse());
    await createOpenAiSummarizer({ client, model: "gpt-5.5" }).summarize(SAMPLE_INPUT);
    const [params] = client.chat.completions.parse.mock.calls[0]!;
    expect(params.model).toBe("gpt-5.5");
  });

  it("throws ReviewerParseError when no parsed message is returned", async () => {
    const client = fakeClient(async () =>
      successResponse({ choices: [{ message: { parsed: null } }] }),
    );
    await expect(createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    await expect(createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    await expect(createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerAuthenticationError,
    );
  });

  it("wraps any other APIError as ReviewerApiError", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    await expect(createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerApiError,
    );
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    await expect(createOpenAiSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      TypeError,
    );
  });

  describe.skipIf(!process.env.OPENAI_API_KEY)("live", () => {
    it("summarizes a real change against the OpenAI API", async () => {
      const { default: OpenAI } = await import("openai");
      const output = await createOpenAiSummarizer({ client: new OpenAI() }).summarize(SAMPLE_INPUT);
      expect(output.summary.whatChanges.length).toBeGreaterThan(0);
      expect(output.usage.inputTokens).toBeGreaterThan(0);
    });
  });
});
