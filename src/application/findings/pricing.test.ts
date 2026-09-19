import { describe, expect, it } from "vitest";
import { CLAUDE_OPUS_5_PRICING, CLAUDE_SONNET_5_PRICING, reviewCostUsd } from "./pricing.js";

describe("reviewCostUsd", () => {
  it("computes cost from input, output, cache-read, and cache-write tokens at claude-opus-5 rates", () => {
    const cost = reviewCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
      CLAUDE_OPUS_5_PRICING,
    );
    // $5 + $25 + $0.50 + $6.25 = $36.75
    expect(cost).toBeCloseTo(36.75, 6);
  });

  it("computes a proportional cost for a realistic small request", () => {
    const cost = reviewCostUsd(
      {
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
      },
      CLAUDE_OPUS_5_PRICING,
    );
    const expected = (1200 / 1_000_000) * 5 + (80 / 1_000_000) * 25 + (900 / 1_000_000) * 0.5;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("returns 0 for all-zero usage", () => {
    expect(
      reviewCostUsd(
        { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        CLAUDE_OPUS_5_PRICING,
      ),
    ).toBe(0);
  });

  it("uses the sonnet-5 rate table when passed explicitly", () => {
    const cost = reviewCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      CLAUDE_SONNET_5_PRICING,
    );
    expect(cost).toBeCloseTo(2, 6);
  });
});
