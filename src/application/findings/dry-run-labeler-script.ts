/**
 * Deterministic pseudo-random oracle-labeler answers for
 * `scripts/findings/label.ts --labeler dry-run`, the labeler-side twin of
 * ../filter/dry-run-judge-script.ts: proves the whole chain (two passes,
 * combination rule, dataset write, cross-tab report, and then a filter run
 * scored against `--label oracle`) end to end without spending a cent.
 *
 * The two framings are drawn from independent streams on purpose: if the dry
 * run always agreed, it would never exercise the `unknown` path, which is the
 * one the real run leans on most.
 *
 * Results are meaningless. `model` says so and `nominalCostUsd` is 0, so a
 * dry-run dataset can never be mistaken for a recorded one.
 */
import type { FakeFindingLabelerScript } from "../../adapters/labelers/fake-finding-labeler.js";
import type {
  ClaimVerificationVerdict,
  FixMatchVerdict,
} from "../../domain/ports/finding-labeler-port.js";
import { hashString, mulberry32 } from "../spike/prng.js";

const FIX_MATCH: readonly FixMatchVerdict[] = ["real", "not-this", "unclear"];
const CLAIM_VERIFICATION: readonly ClaimVerificationVerdict[] = ["present", "absent", "unclear"];

export function generateDryRunLabelerScript(seed = 0): FakeFindingLabelerScript {
  return (input, framing) => {
    const rng = mulberry32((seed ^ hashString(`${input.findingId}::${framing}`)) >>> 0);
    const pool = framing === "fix-match" ? FIX_MATCH : CLAIM_VERIFICATION;
    const verdict = pool[Math.floor(rng() * pool.length)] ?? pool[0] ?? "unclear";
    return {
      framing,
      verdict,
      confidence: Number(rng().toFixed(3)),
      reason: `dry run: no model was called, this verdict is seeded noise (${framing})`,
      model: "dry-run-labeler",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      latencyMs: Math.round(500 + rng() * 1500),
      nominalCostUsd: 0,
    };
  };
}
