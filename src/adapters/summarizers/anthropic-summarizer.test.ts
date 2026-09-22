import { AuthenticationError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ChangeSummaryInput } from "../../domain/ports/change-summarizer-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import { type AnthropicSummaryClient, createAnthropicSummarizer } from "./anthropic-summarizer.js";
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
): AnthropicSummaryClient & { messages: { parse: ReturnType<typeof vi.fn> } } {
  return { messages: { parse: vi.fn(parseImpl) } } as unknown as AnthropicSummaryClient & {
    messages: { parse: ReturnType<typeof vi.fn> };
  };
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01abc",
    model: "claude-sonnet-5",
    parsed_output: STRUCTURED,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

describe("createAnthropicSummarizer", () => {
  it("maps a successful structured-output response to ChangeSummaryOutput", async () => {
    const client = fakeClient(async () => successResponse());
    const summarizer = createAnthropicSummarizer({ client, now: () => 0 });

    const output = await summarizer.summarize(SAMPLE_INPUT);

    expect(output.summary).toEqual({
      whatChanges: STRUCTURED.what_changes,
      behaviorChanges: STRUCTURED.behavior_changes,
      userFacing: true,
      breaking: false,
      areas: ["checkout"],
      risks: [],
    });
    expect(output.model).toBe("claude-sonnet-5");
    expect(output.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
    expect(output.requestId).toBe("msg_01abc");
    expect(output.nominalCostUsd).toBeUndefined();
  });

  it("measures latency with the injectable clock", async () => {
    const client = fakeClient(async () => successResponse());
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1250);
    const output = await createAnthropicSummarizer({ client, now }).summarize(SAMPLE_INPUT);
    expect(output.latencyMs).toBe(250);
  });

  it("defaults to model claude-sonnet-5, effort medium, and the cached summary system prompt", async () => {
    const client = fakeClient(async () => successResponse());
    await createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT);

    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params).toMatchObject({ model: "claude-sonnet-5", output_config: { effort: "medium" } });
    expect(params.system).toEqual([
      { type: "text", text: SUMMARY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain("src/checkout/total.ts");
    expect(params.messages[0].content).toContain("const tax = subtotal * rate;");
  });

  it("never sends the pull request id (no author narrative may leak) nor budget_tokens/prefill", async () => {
    const client = fakeClient(async () => successResponse());
    await createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT);
    const [params] = client.messages.parse.mock.calls[0]!;
    expect(JSON.stringify(params)).not.toContain(SAMPLE_INPUT.prId);
    expect(params.thinking).toBeUndefined();
    expect(params.messages.some((m: { role: string }) => m.role === "assistant")).toBe(false);
  });

  it("allows overriding model, effort, and maxTokens", async () => {
    const client = fakeClient(async () => successResponse());
    await createAnthropicSummarizer({
      client,
      model: "claude-opus-5",
      effort: "high",
      maxTokens: 1024,
    }).summarize(SAMPLE_INPUT);
    const [params] = client.messages.parse.mock.calls[0]!;
    expect(params.model).toBe("claude-opus-5");
    expect(params.output_config.effort).toBe("high");
    expect(params.max_tokens).toBe(1024);
  });

  it("throws ReviewerParseError when parsed_output is null", async () => {
    const client = fakeClient(async () => successResponse({ parsed_output: null }));
    await expect(createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerParseError,
    );
  });

  it("wraps a RateLimitError as ReviewerRateLimitError", async () => {
    const client = fakeClient(async () => {
      throw new RateLimitError(429, {}, "rate limited", new Headers());
    });
    await expect(createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerRateLimitError,
    );
  });

  it("wraps an AuthenticationError as ReviewerAuthenticationError", async () => {
    const client = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    await expect(createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerAuthenticationError,
    );
  });

  it("wraps any other APIError as ReviewerApiError", async () => {
    const client = fakeClient(async () => {
      throw new BadRequestError(400, {}, "bad request", new Headers());
    });
    await expect(createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      ReviewerApiError,
    );
  });

  it("rethrows a non-API error unwrapped", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("boom");
    });
    await expect(createAnthropicSummarizer({ client }).summarize(SAMPLE_INPUT)).rejects.toThrow(
      TypeError,
    );
  });

  describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live", () => {
    it("summarizes a real change against the Anthropic API", async () => {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const output = await createAnthropicSummarizer({ client: new Anthropic() }).summarize(
        SAMPLE_INPUT,
      );
      expect(output.summary.whatChanges.length).toBeGreaterThan(0);
      expect(output.usage.inputTokens).toBeGreaterThan(0);
    });
  });
});
