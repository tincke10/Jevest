/**
 * Deterministic pseudo-random scripted answers for `scripts/filter/run.ts
 * --mode dry-run`. Mirrors `spike/dry-run-script.ts` and
 * `profile/dry-run-profile-script.ts` for the filter question set
 * (is_real_defect noul, severity score, is_style_only noul, actionable
 * noul). Feeds a `FakeDecisionAdapter`; results are meaningless, only
 * proves the pipeline works end to end without a TypeSafe API key.
 */
import type { Decision } from "../../domain/decision.js";
import { hashString, mulberry32 } from "../spike/prng.js";
import { fanOutKey } from "../spike/questions.js";
import type { FindingRecord } from "./finding-record.js";

function randomDistribution4(rng: () => number): [number, number, number, number] {
  const a = rng() + 0.01;
  const b = rng() + 0.01;
  const c = rng() + 0.01;
  const d = rng() + 0.01;
  const sum = a + b + c + d;
  return [a / sum, b / sum, c / sum, d / sum];
}

export function generateDryRunFilterScript(
  findings: readonly FindingRecord[],
  seed = 0,
): Record<string, Decision> {
  const script: Record<string, Decision> = {};

  for (const finding of findings) {
    const rng = mulberry32((seed ^ hashString(finding.id)) >>> 0);

    script[fanOutKey(finding.id, "is_real_defect")] = { type: "noul", noul: rng() };

    const [p0, p1, p2, p3] = randomDistribution4(rng);
    const score = p0 * 0 + p1 * 1 + p2 * 2 + p3 * 3;
    script[fanOutKey(finding.id, "severity")] = {
      type: "score",
      score,
      confidence: 0.3 + rng() * 0.6,
      legend: { 0: "nit", 1: "minor", 2: "major", 3: "critical" },
      probabilities: { 0: p0, 1: p1, 2: p2, 3: p3 },
    };

    script[fanOutKey(finding.id, "is_style_only")] = { type: "noul", noul: rng() };
    script[fanOutKey(finding.id, "actionable")] = { type: "noul", noul: rng() };
  }

  return script;
}
