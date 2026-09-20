import { describe, expect, it } from "vitest";
import {
  CLAUDE_OPUS_5_PRICING,
  CLAUDE_SONNET_5_PRICING,
  DEEPSEEK_FLASH_PRICING,
  DEEPSEEK_V4_PRO_PRICING,
  pricingForModel,
  reviewCostUsd,
} from "./pricing.js";

describe("pricingForModel", () => {
  it("maps claude model ids by family", () => {
    expect(pricingForModel("claude-opus-5")).toBe(CLAUDE_OPUS_5_PRICING);
    expect(pricingForModel("claude-sonnet-5")).toBe(CLAUDE_SONNET_5_PRICING);
  });

  it("maps deepseek model ids, flash cheaper than v4-pro", () => {
    expect(pricingForModel("deepseek-v4-pro")).toBe(DEEPSEEK_V4_PRO_PRICING);
    expect(pricingForModel("deepseek-flash")).toBe(DEEPSEEK_FLASH_PRICING);
    expect(DEEPSEEK_FLASH_PRICING.inputPerMTok).toBeLessThan(DEEPSEEK_V4_PRO_PRICING.inputPerMTok);
  });

  it("falls back to the sonnet-5 table for an unknown model id", () => {
    expect(pricingForModel("gpt-5.6-luna")).toBe(CLAUDE_SONNET_5_PRICING);
  });

  it("deepseek tables bill cache hits below cache misses and never charge cache writes", () => {
    for (const pricing of [DEEPSEEK_V4_PRO_PRICING, DEEPSEEK_FLASH_PRICING]) {
      expect(pricing.cacheReadPerMTok).toBeLessThan(pricing.inputPerMTok);
      expect(pricing.cacheWritePerMTok).toBe(0);
    }
  });
});

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
