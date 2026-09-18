import {
  AuthenticationError,
  InternalServerError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../domain/question.js";
import {
  type DecisionApiClient,
  createTypeSafeDecisionAdapter,
} from "./typesafe-decision-adapter.js";

function fakeClient(
  systemOneImpl: (
    request: unknown,
    options: unknown,
  ) => Promise<{ data: unknown; requestId: string | undefined }>,
): DecisionApiClient & { systemOne: ReturnType<typeof vi.fn> } {
  const systemOne = vi.fn((request: unknown, options: unknown) => ({
    withResponse: () => systemOneImpl(request, options),
  }));
  return { systemOne } as unknown as DecisionApiClient & { systemOne: ReturnType<typeof vi.fn> };
}

function noRetryDelay() {
  return { sleep: vi.fn(async () => {}), random: () => 0 };
}

describe("TypeSafeDecisionAdapter", () => {
  describe("mapping", () => {
    it("maps a noul question to the SDK builder and the SDK noul answer back to a NoulDecision", async () => {
      const client = fakeClient(async (request) => ({
        data: {
          model: "jev-latest",
          usage: { input_tokens: 12, output_tokens: 0 },
          answers: { flag: { type: "noul", noul: 0.73 } },
        },
        requestId: "req_1",
      }));
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay() });

      const response = await adapter.decide("some state", {
        flag: {
          type: "noul",
          instructions: "risky?",
          criteria: { true: "yes desc" },
        } satisfies NoulQuestion,
      });

      expect(response.answers.flag).toEqual({ type: "noul", noul: 0.73 });
      expect(response.requestId).toBe("req_1");
      expect(response.model).toBe("jev-latest");
      expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 0 });

      const [sentRequest] = client.systemOne.mock.calls[0]!;
      expect((sentRequest as { questions: Record<string, unknown> }).questions.flag).toMatchObject({
        type: "noul",
        instructions: "risky?",
      });
    });

    it("maps a choice question and choice answer round-trip", async () => {
      const client = fakeClient(async () => ({
        data: {
          model: "jev-latest",
          usage: { input_tokens: 5, output_tokens: 0 },
          answers: {
            category: {
              type: "choice",
              choice: "security",
              confidence: 0.9,
              probabilities: { security: 0.9, docs: 0.1 },
            },
          },
        },
        requestId: "req_2",
      }));
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay() });

      const response = await adapter.decide("state", {
        category: {
          type: "choice",
          instructions: "categorize",
          criteria: { security: "touches security", docs: "docs only" },
        } satisfies ChoiceQuestion,
      });

      expect(response.answers.category).toEqual({
        type: "choice",
        choice: "security",
        confidence: 0.9,
        probabilities: { security: 0.9, docs: 0.1 },
      });
    });

    it("maps a score question and score answer round-trip", async () => {
      const client = fakeClient(async () => ({
        data: {
          model: "jev-latest",
          usage: { input_tokens: 8, output_tokens: 0 },
          answers: {
            risk: {
              type: "score",
              score: 1.4,
              confidence: 0.5,
              legend: { 0: "low", 1: "medium", 2: "high" },
              probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
            },
          },
        },
        requestId: "req_3",
      }));
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay() });

      const response = await adapter.decide("state", {
        risk: {
          type: "score",
          instructions: "rate",
          criteria: ["low", "medium", "high"],
        } satisfies ScoreQuestion,
      });

      expect(response.answers.risk).toEqual({
        type: "score",
        score: 1.4,
        confidence: 0.5,
        legend: { 0: "low", 1: "medium", 2: "high" },
        probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
      });
    });

    it("measures latency using the injected clock", async () => {
      const client = fakeClient(async () => ({
        data: {
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          answers: { flag: { type: "noul", noul: 0.1 } },
        },
        requestId: "r",
      }));
      const times = [1000, 1123];
      const now = () => times.shift()!;
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay(), now });

      const response = await adapter.decide("s", {
        flag: { type: "noul", instructions: "x" } satisfies NoulQuestion,
      });

      expect(response.latencyMs).toBe(123);
    });

    it("passes the configured timeout to each call, defaulting to 3000ms", async () => {
      const client = fakeClient(async () => ({
        data: {
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          answers: { flag: { type: "noul", noul: 0.1 } },
        },
        requestId: "r",
      }));
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay() });
      await adapter.decide("s", {
        flag: { type: "noul", instructions: "x" } satisfies NoulQuestion,
      });

      const [, options] = client.systemOne.mock.calls[0]!;
      expect((options as { timeout: number }).timeout).toBe(3000);
    });

    it("honors a custom timeoutMs", async () => {
      const client = fakeClient(async () => ({
        data: {
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          answers: { flag: { type: "noul", noul: 0.1 } },
        },
        requestId: "r",
      }));
      const adapter = createTypeSafeDecisionAdapter({ client, ...noRetryDelay(), timeoutMs: 1500 });
      await adapter.decide("s", {
        flag: { type: "noul", instructions: "x" } satisfies NoulQuestion,
      });

      const [, options] = client.systemOne.mock.calls[0]!;
      expect((options as { timeout: number }).timeout).toBe(1500);
    });
  });

  describe("retries", () => {
    it("retries on RateLimitError (429) with exponential backoff and jitter, then succeeds", async () => {
      let calls = 0;
      const client = fakeClient(async () => {
        calls += 1;
        if (calls < 3) {
          throw new RateLimitError(429, undefined, new Headers());
        }
        return {
          data: {
            model: "m",
            usage: { input_tokens: 0, output_tokens: 0 },
            answers: { flag: { type: "noul", noul: 0.1 } },
          },
          requestId: "r",
        };
      });
      const sleep = vi.fn(async (_ms: number) => {});
      const random = () => 0.5;
      const adapter = createTypeSafeDecisionAdapter({
        client,
        sleep,
        random,
        retry: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.25 },
      });

      const response = await adapter.decide("s", {
        flag: { type: "noul", instructions: "x" } satisfies NoulQuestion,
      });

      expect(calls).toBe(3);
      expect(response.answers.flag).toEqual({ type: "noul", noul: 0.1 });
      expect(sleep).toHaveBeenCalledTimes(2);
      // attempt 0 delay: base 100ms, jitter subtracts up to 25% * random(0.5) => 100 - 12.5 = 87.5
      expect(sleep.mock.calls[0]![0]).toBeCloseTo(87.5, 5);
      // attempt 1 delay: base 200ms (doubled), jitter subtracts 25%*0.5 => 200 - 25 = 175
      expect(sleep.mock.calls[1]![0]).toBeCloseTo(175, 5);
    });

    it("retries on InternalServerError (5xx, including 529) up to maxRetries then throws", async () => {
      const client = fakeClient(async () => {
        throw new InternalServerError(529, undefined, new Headers());
      });
      const sleep = vi.fn(async () => {});
      const adapter = createTypeSafeDecisionAdapter({
        client,
        sleep,
        random: () => 0,
        retry: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      });

      await expect(
        adapter.decide("s", { flag: { type: "noul", instructions: "x" } satisfies NoulQuestion }),
      ).rejects.toBeInstanceOf(InternalServerError);

      expect(client.systemOne).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("does not retry on AuthenticationError (401)", async () => {
      const client = fakeClient(async () => {
        throw new AuthenticationError(401, undefined, new Headers());
      });
      const sleep = vi.fn(async () => {});
      const adapter = createTypeSafeDecisionAdapter({ client, sleep, random: () => 0 });

      await expect(
        adapter.decide("s", { flag: { type: "noul", instructions: "x" } satisfies NoulQuestion }),
      ).rejects.toBeInstanceOf(AuthenticationError);

      expect(client.systemOne).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("does not retry on UnprocessableEntityError (422)", async () => {
      const client = fakeClient(async () => {
        throw new UnprocessableEntityError(422, undefined, new Headers());
      });
      const sleep = vi.fn(async () => {});
      const adapter = createTypeSafeDecisionAdapter({ client, sleep, random: () => 0 });

      await expect(
        adapter.decide("s", { flag: { type: "noul", instructions: "x" } satisfies NoulQuestion }),
      ).rejects.toBeInstanceOf(UnprocessableEntityError);

      expect(client.systemOne).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe.skipIf(!process.env.TYPESAFE_API_KEY)("live", () => {
    it("answers a real noul question against the TypeSafe API", async () => {
      const { TypeSafeClient } = await import("@typesafe-ai/sdk");
      const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
      const adapter = createTypeSafeDecisionAdapter({ client });

      const response = await adapter.decide("I was charged twice. Please fix this ASAP.", {
        billing: { type: "noul", instructions: "Is this about billing?" } satisfies NoulQuestion,
      });

      expect(response.answers.billing.noul).toBeGreaterThanOrEqual(0);
      expect(response.answers.billing.noul).toBeLessThanOrEqual(1);
    });
  });
});
