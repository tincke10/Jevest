/**
 * Cost accounting for reviewer usage (SPEC FR-9.2, §5 Fase 1a step 5 "costo").
 * Kept out of the adapters on purpose: pricing is a business/reporting
 * concern, not something an SDK adapter should know about (hexagonal rule,
 * SPEC §7). Prices are per the task brief / docs/SPEC.md §13 decisions,
 * current as of 2026-09-19 — check the provider's pricing page before
 * trusting these for a new model.
 */
import type { ReviewUsage } from "../../domain/ports/reviewer-port.js";

export interface ModelPricing {
  /** USD per million input tokens (non-cached). */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
  /** USD per million cache-read input tokens. */
  readonly cacheReadPerMTok: number;
  /** USD per million cache-write (cache-creation) input tokens. */
  readonly cacheWritePerMTok: number;
}

/** claude-opus-5: $5/$25 per MTok in/out; cache read ~0.1x input, cache write ~1.25x input. */
export const CLAUDE_OPUS_5_PRICING: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

/** claude-sonnet-5: $2/$10 per MTok in/out; same cache-read/write ratios as Opus 5. */
export const CLAUDE_SONNET_5_PRICING: ModelPricing = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
};

/**
 * deepseek-v4-pro (DeepSeek-V4-Pro), PEAK rates per
 * https://api-docs.deepseek.com/quick_start/pricing as of 2026-09-20:
 * $1.32 / MTok input on cache miss, $0.044 on cache hit, $3.96 output.
 * Off-peak (outside 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) is roughly
 * half; peak is used here so the budget cut-off (NFR-10) never
 * under-estimates. DeepSeek bills a cache miss at the plain input rate and
 * lists no separate cache-write charge, hence cacheWritePerMTok 0 — the
 * adapter reports cache misses as `inputTokens`, so nothing is skipped.
 */
export const DEEPSEEK_V4_PRO_PRICING: ModelPricing = {
  inputPerMTok: 1.32,
  outputPerMTok: 3.96,
  cacheReadPerMTok: 0.044,
  cacheWritePerMTok: 0,
};

/** deepseek-flash (DeepSeek-V4.1-Flash), peak: $0.30 in (miss), $0.006 (hit), $1.20 out. Same source/date. */
export const DEEPSEEK_FLASH_PRICING: ModelPricing = {
  inputPerMTok: 0.3,
  outputPerMTok: 1.2,
  cacheReadPerMTok: 0.006,
  cacheWritePerMTok: 0,
};

/**
 * Picks the rate table for a `reviewer.model` id by family. Unknown ids
 * (including OpenAI's, whose pricing isn't confirmed in this repo's
 * sources) fall back to the Sonnet 5 table rather than $0, so the budget
 * cut-off still bites on a mis-typed model name.
 */
export function pricingForModel(model: string): ModelPricing {
  if (model.includes("opus")) {
    return CLAUDE_OPUS_5_PRICING;
  }
  if (model.startsWith("deepseek-flash") || model.startsWith("deepseek-v4-flash")) {
    return DEEPSEEK_FLASH_PRICING;
  }
  if (model.startsWith("deepseek")) {
    return DEEPSEEK_V4_PRO_PRICING;
  }
  return CLAUDE_SONNET_5_PRICING;
}

const MTOK = 1_000_000;

/** Cost in USD of one reviewer call, given its usage and the model's pricing. */
export function reviewCostUsd(usage: ReviewUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens / MTOK) * pricing.inputPerMTok +
    (usage.outputTokens / MTOK) * pricing.outputPerMTok +
    (usage.cacheReadInputTokens / MTOK) * pricing.cacheReadPerMTok +
    (usage.cacheCreationInputTokens / MTOK) * pricing.cacheWritePerMTok
  );
}

/**
 * Jev (TypeSafe AI) list price per the task brief and config/jevest.example.yml:
 * $0.042 per million INPUT tokens; output is not billed separately. Used
 * to book Jev's (negligible) share into the cumulative spend ledger so the
 * cap counts everything the run cost, not just the LLM reviewer.
 */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

export function jevCostUsd(inputTokens: number): number {
  return (inputTokens / MTOK) * JEV_INPUT_USD_PER_MTOK;
}
