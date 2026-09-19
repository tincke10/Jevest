/**
 * Deterministic pseudo-random scripted answers for `scripts/spike/run-profile.ts
 * --mode dry-run`. Mirrors `spike/dry-run-script.ts` but for the profile
 * question set (one choice + four nouls instead of one score + two nouls).
 * Feeds a {@link FakeDecisionAdapter}; results are meaningless, only proves
 * the pipeline works end to end without a TypeSafe API key.
 */
import type { Decision } from "../../domain/decision.js";
import type { HunkRecord } from "../spike/hunk-record.js";
import { hashString, mulberry32 } from "../spike/prng.js";
import { fanOutKey } from "../spike/questions.js";
import type { ProfileChangeKind } from "./profile-label-record.js";

function randomDistribution4(rng: () => number): [number, number, number, number] {
  const a = rng() + 0.01;
  const b = rng() + 0.01;
  const c = rng() + 0.01;
  const d = rng() + 0.01;
  const sum = a + b + c + d;
  return [a / sum, b / sum, c / sum, d / sum];
}

/** Picks the highest-probability change kind without indexing into an array. */
function pickMaxChangeKind(p0: number, p1: number, p2: number, p3: number): ProfileChangeKind {
  let best: ProfileChangeKind = "add-behavior";
  let bestValue = p0;
  if (p1 > bestValue) {
    best = "modify-behavior";
    bestValue = p1;
  }
  if (p2 > bestValue) {
    best = "delete";
    bestValue = p2;
  }
  if (p3 > bestValue) {
    best = "rename-or-format";
    bestValue = p3;
  }
  return best;
}

export function generateDryRunProfileScript(
  hunks: readonly HunkRecord[],
  seed = 0,
): Record<string, Decision> {
  const script: Record<string, Decision> = {};

  for (const hunk of hunks) {
    const rng = mulberry32((seed ^ hashString(hunk.id)) >>> 0);

    const [p0, p1, p2, p3] = randomDistribution4(rng);
    const choice = pickMaxChangeKind(p0, p1, p2, p3);

    script[fanOutKey(hunk.id, "change_kind")] = {
      type: "choice",
      choice,
      confidence: 0.3 + rng() * 0.6,
      probabilities: {
        "add-behavior": p0,
        "modify-behavior": p1,
        delete: p2,
        "rename-or-format": p3,
      },
    };

    script[fanOutKey(hunk.id, "touches_public_api")] = { type: "noul", noul: rng() };
    script[fanOutKey(hunk.id, "touches_error_handling")] = { type: "noul", noul: rng() };
    script[fanOutKey(hunk.id, "touches_async")] = { type: "noul", noul: rng() };
    script[fanOutKey(hunk.id, "touches_io")] = { type: "noul", noul: rng() };
  }

  return script;
}
