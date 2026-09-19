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
