import { AuthenticationError, BadRequestError, RateLimitError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";
import {
  ReviewerApiError,
  ReviewerAuthenticationError,
  ReviewerParseError,
  ReviewerRateLimitError,
} from "../reviewers/reviewer-errors.js";
import {
  DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT,
  DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT,
  type DeepSeekLabelerChatClient,
  createDeepSeekFindingLabeler,
} from "./deepseek-finding-labeler.js";
import { CLAIM_VERIFICATION_SYSTEM_PROMPT, FIX_MATCH_SYSTEM_PROMPT } from "./labeler-prompt.js";

const INPUT: FindingLabelerInput = {
  findingId: "zod-9446b5c-1::claude-cli::0",
  claim: "The wrong context is passed to newVar.",
  rationale: "ctx is the outer context; the inner one is ctx2.",
  file: "packages/zod/src/v4/core/compile.ts",
  lineStart: 1268,
  lineEnd: 1268,
  hunkHeader: "@@ -1268,3 +1268,3 @@",
  language: "ts",
  before: "const outputVar = newVar(ctx);",
  after: "const outputVar = newVar(ctx2);",
  commitMessage: "fix: pass the inner context to newVar (#6585)",
  hunkIsDefect: true,
};

type FakeClient = DeepSeekLabelerChatClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(createImpl: (params: unknown) => Promise<unknown>): FakeClient {
  return { chat: { completions: { create: vi.fn(createImpl) } } } as unknown as FakeClient;
}

function successResponse(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_ds_lbl_01",
    model: "deepseek-v4-pro",
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 2200,
      completion_tokens: 140,
      prompt_cache_hit_tokens: 1800,
      prompt_cache_miss_tokens: 400,
    },
    ...overrides,
  };
}

const FIX_MATCH_ANSWER = {
  verdict: "real",
  confidence: 0.9,
  reason: "The fix swaps ctx for ctx2.",
};
const CLAIM_ANSWER = { verdict: "present", confidence: 0.8, reason: "The before code passes ctx." };

describe("createDeepSeekFindingLabeler", () => {
  it("maps a fix-match response onto the framing's verdict vocabulary", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    const output = await createDeepSeekFindingLabeler({ client }).labelFixMatch(INPUT);

    expect(output.framing).toBe("fix-match");
    expect(output.verdict).toBe("real");
    expect(output.confidence).toBe(0.9);
    expect(output.reason).toBe("The fix swaps ctx for ctx2.");
    expect(output.model).toBe("deepseek-v4-pro");
    expect(output.requestId).toBe("chatcmpl_ds_lbl_01");
    expect(output.nominalCostUsd).toBeUndefined();
    expect(output.sessionId).toBeUndefined();
  });

  it("maps a claim-verification response onto its own verdict vocabulary", async () => {
    const client = fakeClient(async () => successResponse(CLAIM_ANSWER));
    const output = await createDeepSeekFindingLabeler({ client }).labelClaimVerification(INPUT);

    expect(output.framing).toBe("claim-verification");
    expect(output.verdict).toBe("present");
    expect(output.confidence).toBe(0.8);
  });

  it("splits usage into cache-miss input and cache-hit tokens so cost math never double-counts", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    const output = await createDeepSeekFindingLabeler({ client }).labelFixMatch(INPUT);
    expect(output.usage).toEqual({
      inputTokens: 400,
      outputTokens: 140,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 0,
    });
  });

  it("sends each framing's own system prompt and the shared user message", async () => {
    const client = fakeClient(async (params) => {
      const system = (params as { messages: { content: string }[] }).messages[0]?.content ?? "";
      return successResponse(
        system === DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT ? FIX_MATCH_ANSWER : CLAIM_ANSWER,
      );
    });
    const labeler = createDeepSeekFindingLabeler({ client });
    await labeler.labelFixMatch(INPUT);
    await labeler.labelClaimVerification(INPUT);

    const [first] = client.chat.completions.create.mock.calls[0]!;
    const [second] = client.chat.completions.create.mock.calls[1]!;
    expect(first.messages[0].content).toBe(DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT);
    expect(second.messages[0].content).toBe(DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT);
    expect(first.messages[1].content).toBe(second.messages[1].content);
    expect(first.messages[1].content).toContain(INPUT.after);
    expect(first.messages[1].content).toContain(INPUT.commitMessage);
  });

  it("defaults to deepseek-v4-pro, json_object output and max_tokens 8192 (reasoning counts against it)", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    await createDeepSeekFindingLabeler({ client }).labelFixMatch(INPUT);

    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-v4-pro");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.max_tokens).toBe(8192);
    expect(JSON.stringify(params)).not.toContain(INPUT.findingId);
  });

  it("honours a model and max_tokens override", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    await createDeepSeekFindingLabeler({
      client,
      model: "deepseek-flash",
      maxTokens: 2048,
    }).labelFixMatch(INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    expect(params.model).toBe("deepseek-flash");
    expect(params.max_tokens).toBe(2048);
  });

  it("never shows the labeler an existing label or any Jev / judge output", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    await createDeepSeekFindingLabeler({ client }).labelFixMatch(INPUT);
    const [params] = client.chat.completions.create.mock.calls[0]!;
    const sent = JSON.stringify(params);
    expect(sent).not.toContain("line-overlap");
    expect(sent).not.toContain("is_real_defect");
  });

  it("both system prompts extend the shared framing prompt and satisfy DeepSeek's json_object contract", () => {
    expect(DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT.startsWith(FIX_MATCH_SYSTEM_PROMPT)).toBe(true);
    expect(
      DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT.startsWith(CLAIM_VERIFICATION_SYSTEM_PROMPT),
    ).toBe(true);
    for (const prompt of [
      DEEPSEEK_FIX_MATCH_SYSTEM_PROMPT,
      DEEPSEEK_CLAIM_VERIFICATION_SYSTEM_PROMPT,
    ]) {
      expect(prompt.toLowerCase()).toContain("json");
    }
  });

  it("measures latency with the injected clock", async () => {
    const client = fakeClient(async () => successResponse(FIX_MATCH_ANSWER));
    const times = [1000, 3500];
    let i = 0;
    const output = await createDeepSeekFindingLabeler({
      client,
      now: () => times[i++] ?? 0,
    }).labelFixMatch(INPUT);
    expect(output.latencyMs).toBe(2500);
  });

  it("rejects a verdict from the other framing as a parse error, never as a coerced answer", async () => {
    const client = fakeClient(async () => successResponse(CLAIM_ANSWER));
    await expect(
      createDeepSeekFindingLabeler({ client }).labelFixMatch(INPUT),
    ).rejects.toBeInstanceOf(ReviewerParseError);
  });

  it("names truncation in the parse error when the reasoning ate the token budget", async () => {
    const client = fakeClient(async () =>
      successResponse({}, { choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    );
    const error = await createDeepSeekFindingLabeler({ client })
      .labelFixMatch(INPUT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewerParseError);
    expect((error as Error).message).toContain("max_tokens=8192");
    expect((error as Error).message).toContain("finish_reason=length");
  });

  it("maps rate limits, auth failures and other API errors onto the shared reviewer errors", async () => {
    const rateLimited = fakeClient(async () => {
      throw new RateLimitError(429, {}, "slow down", new Headers());
    });
    await expect(
      createDeepSeekFindingLabeler({ client: rateLimited }).labelFixMatch(INPUT),
    ).rejects.toBeInstanceOf(ReviewerRateLimitError);

    const unauthorized = fakeClient(async () => {
      throw new AuthenticationError(401, {}, "bad key", new Headers());
    });
    await expect(
      createDeepSeekFindingLabeler({ client: unauthorized }).labelFixMatch(INPUT),
    ).rejects.toBeInstanceOf(ReviewerAuthenticationError);

    const badRequest = fakeClient(async () => {
      throw new BadRequestError(400, {}, "nope", new Headers());
    });
    await expect(
      createDeepSeekFindingLabeler({ client: badRequest }).labelFixMatch(INPUT),
    ).rejects.toBeInstanceOf(ReviewerApiError);
  });
});
