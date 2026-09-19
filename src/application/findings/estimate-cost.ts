import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewUserPrompt,
} from "../../adapters/reviewers/review-prompt.js";
/**
 * `--estimate` support for scripts/findings/generate.ts: counts tokens for a
 * small sample of hunks (no model call, so it costs nothing) and extrapolates
 * to the full run. Deliberately conservative: it prices every request's
 * input tokens at the full (non-cached) rate, ignoring the prompt-caching
 * discount the real run gets on the repeated system prompt — so the real
 * cost should come in at or under this number, never over it. Output tokens
 * aren't knowable without actually calling the model, so they're a caller-
 * supplied flat assumption per hunk, not measured.
 */
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import type { ModelPricing } from "./pricing.js";

/** The subset of the Anthropic client `--estimate` depends on. */
export interface CountTokensClient {
  messages: {
    countTokens(params: {
      model: string;
      system: Array<{ type: "text"; text: string }>;
      messages: Array<{ role: "user"; content: string }>;
    }): Promise<{ input_tokens: number }>;
  };
}

export interface EstimateReviewCostOptions {
  readonly client: CountTokensClient;
  readonly hunks: readonly HunkRecord[];
  readonly model?: string;
  /** How many hunks to actually call countTokens on. */
  readonly sampleSize: number;
  /** How many hunks to extrapolate the estimate over. */
  readonly targetHunks: number;
  readonly pricing: ModelPricing;
  /** Flat per-hunk output-token assumption; real usage may differ. */
  readonly assumedOutputTokensPerHunk: number;
}

export interface ReviewCostEstimate {
  readonly avgInputTokensPerHunk: number;
  readonly sampleSize: number;
  readonly targetHunks: number;
  readonly estimatedTotalUsd: number;
}

const DEFAULT_MODEL = "claude-opus-5";

function toReviewInput(hunk: HunkRecord): ReviewInput {
  return {
    hunkId: hunk.id,
    file: hunk.file,
    language: hunk.language,
    hunkHeader: hunk.hunkHeader,
    before: hunk.before,
    diff: hunk.diff,
  };
}

export async function estimateReviewCostUsd(
  options: EstimateReviewCostOptions,
): Promise<ReviewCostEstimate> {
  const model = options.model ?? DEFAULT_MODEL;
  const sample = options.hunks.slice(0, options.sampleSize);

  const counts = await Promise.all(
    sample.map((hunk) =>
      options.client.messages.countTokens({
        model,
        system: [{ type: "text", text: REVIEW_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: buildReviewUserPrompt(toReviewInput(hunk)) }],
      }),
    ),
  );

  const avgInputTokensPerHunk =
    counts.reduce((sum, count) => sum + count.input_tokens, 0) / counts.length;

  const estimatedInputCost =
    ((avgInputTokensPerHunk * options.targetHunks) / 1_000_000) * options.pricing.inputPerMTok;
  const estimatedOutputCost =
    ((options.assumedOutputTokensPerHunk * options.targetHunks) / 1_000_000) *
    options.pricing.outputPerMTok;

  return {
    avgInputTokensPerHunk,
    sampleSize: counts.length,
    targetHunks: options.targetHunks,
    estimatedTotalUsd: estimatedInputCost + estimatedOutputCost,
  };
}
