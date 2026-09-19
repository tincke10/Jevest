/**
 * Deterministic pseudo-random scripted answers for `scripts/spike/run.ts
 * --mode dry-run`, so the CLI pipeline can be exercised end to end before a
 * TypeSafe API key exists. Feeds a {@link FakeDecisionAdapter}. The
 * resulting metrics are meaningless — this only proves the plumbing works.
 */
import type { Decision } from "../../domain/decision.js";
import type { HunkRecord } from "./hunk-record.js";
import { hashString, mulberry32 } from "./prng.js";
import { fanOutKey } from "./questions.js";

/** A random 4-way distribution summing to 1, as a fixed-length tuple (no index-access-on-array needed by callers). */
function randomDistribution4(rng: () => number): [number, number, number, number] {
  const a = rng() + 0.01; // + 0.01 avoids an all-zero draw
  const b = rng() + 0.01;
  const c = rng() + 0.01;
  const d = rng() + 0.01;
  const sum = a + b + c + d;
  return [a / sum, b / sum, c / sum, d / sum];
}

/**
 * Generates a full script (every fan-out question, for every hunk) that a
 * {@link FakeDecisionAdapter} can serve. Deterministic: the same `seed` and
 * `hunks` always produce the same script, independent of call count.
 */
export function generateDryRunScript(
  hunks: readonly HunkRecord[],
  seed = 0,
): Record<string, Decision> {
  const script: Record<string, Decision> = {};

  for (const hunk of hunks) {
    const rng = mulberry32((seed ^ hashString(hunk.id)) >>> 0);

    const [p0, p1, p2, p3] = randomDistribution4(rng);
    const score = p0 * 0 + p1 * 1 + p2 * 2 + p3 * 3;
    script[fanOutKey(hunk.id, "defect_likelihood")] = {
      type: "score",
      score,
      confidence: 0.3 + rng() * 0.6,
      legend: { 0: "none", 1: "unlikely", 2: "likely", 3: "certain" },
      probabilities: { 0: p0, 1: p1, 2: p2, 3: p3 },
    };

    script[fanOutKey(hunk.id, "touches_public_api")] = { type: "noul", noul: rng() };
    script[fanOutKey(hunk.id, "touches_security")] = { type: "noul", noul: rng() };
  }

  return script;
}
