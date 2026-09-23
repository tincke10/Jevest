/**
 * Stage 4: finding filter (SPEC FR-5). Reuses `filter/finding-questions.ts`
 * and `filter/filter-runner.ts` verbatim (same fan-out mechanics, same
 * four questions) rather than duplicating them — findings from the LLM
 * reviewer are wrapped into `FindingRecord`-shaped objects (the dataset
 * fields the filter runner never reads — `datasetVersion`, `label`,
 * `needsManualReview`, `usage`, `costUsd`, `latencyMs` — are unused
 * placeholders here, since a live pipeline finding has no ground truth or
 * dataset provenance) purely so the exact same `runFilter` can process
 * them. One Jev request per finding (NFR-14, already `runFilter`'s
 * default).
 *
 * `is_real_defect` may pass through a post-hoc calibration map before
 * anything reads it (SPEC §4.6.3, `findingFilter.calibration`, default
 * "none"). The map is monotone, so it cannot reorder findings — what it
 * changes is where the fixed thresholds in `.jevest.yml` fall on the curve.
 * The raw answer is kept on every record as `rawIsRealDefectProb`.
 */
import {
  type CalibrationMap,
  NO_CALIBRATION,
  applyCalibration,
} from "../../../domain/calibration.js";
import {
  type ConfidencePolicyConfig,
  createConfidencePolicy,
} from "../../../domain/confidence-policy.js";
import type { Usage } from "../../../domain/decision.js";
import type { DecisionPort } from "../../../domain/ports/decision-port.js";
import { runFilter } from "../../filter/filter-runner.js";
import type { FindingRecord } from "../../filter/finding-record.js";
import type { ReviewStageEntry } from "./review.js";
import type { RiskLevel } from "./triage.js";

export interface FilteredFinding {
  readonly findingId: string;
  readonly hunkId: string;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly claim: string;
  readonly rationale: string;
  /**
   * The probability everything downstream uses: the band, the predicted-real
   * cut, the summary comment. Equal to {@link rawIsRealDefectProb} unless a
   * calibration map is configured (`findingFilter.calibration: file`).
   */
  readonly isRealDefectProb: number;
  /**
   * What Jev actually answered, kept whatever the calibration does to it. A
   * calibrated 0.42 next to a raw 0.85 is the difference between "Jev was
   * unsure" and "Jev was sure and has been wrong at that level before" — a
   * report that only carried the first could never tell you which.
   */
  readonly rawIsRealDefectProb: number;
  /** Jev's own continuous severity score (0..3, nit..critical), independent of the LLM's suggestedSeverity. */
  readonly jevSeverityScore: number;
  readonly isStyleOnlyProb: number;
  readonly actionableProb: number;
  readonly requestId: string;
  /** NFR-2 fail-closed: true when Jev failed to classify this finding — routed to needsHuman as "unverified" rather than dropped. */
  readonly unverified: boolean;
}

/**
 * Product decision (2026-09-22, see docs/BENCHMARK.md "H1"): H1 found Jev's
 * is_real_defect judgment near chance against the current labels, so the
 * label isn't trustworthy enough to discard findings on yet.
 * `"annotate"` (default, see config/jevest.example.yml `findingFilter.mode`)
 * never puts anything in `discarded` — what would have been dropped goes
 * to `lowConfidence` instead. `"discard"` is the original behavior.
 */
export type FindingFilterMode = "annotate" | "discard";

export interface FindingFilterStageInput {
  readonly reviews: readonly ReviewStageEntry[];
  /** hunkId -> diff, so `buildFindingState` can look up the hunk each finding is about. */
  readonly hunksById: ReadonlyMap<string, string>;
  readonly decisionPort: DecisionPort;
  readonly policyConfig: ConfidencePolicyConfig;
  readonly riskLevel: RiskLevel;
  readonly mode: FindingFilterMode;
  /**
   * Post-hoc map applied to `is_real_defect` BEFORE the band and the
   * predicted-real cut (SPEC §4.6.3). Default: the identity, so a caller that
   * knows nothing about calibration gets exactly the behavior every committed
   * benchmark measured. Resolved by run-pipeline.ts from
   * `findingFilter.calibration`.
   */
  readonly calibration?: CalibrationMap;
}

export interface FindingFilterStageResult {
  readonly published: FilteredFinding[];
  readonly needsHuman: FilteredFinding[];
  readonly discarded: FilteredFinding[];
  /**
   * `mode: "annotate"` only: findings that would have been discarded, kept
   * here instead so nothing is silently dropped while H1 is pending a valid
   * verdict. Always empty in `mode: "discard"`.
   */
  readonly lowConfidence: FilteredFinding[];
  readonly totalRequests: number;
  readonly totalLatencyMs: number;
  readonly totalUsage: Usage;
  /** One entry per Jev request that answered (a failed request has no latency), for the run's H4 percentiles (run-metrics.ts). */
  readonly requestLatenciesMs: readonly number[];
}

const SEVERITY_LEVELS = ["nit", "minor", "major", "critical"] as const;

function jevSeverityLevel(score: number): (typeof SEVERITY_LEVELS)[number] {
  const index = Math.min(SEVERITY_LEVELS.length - 1, Math.max(0, Math.round(score)));
  return SEVERITY_LEVELS[index] as (typeof SEVERITY_LEVELS)[number];
}

/**
 * How concentrated a noul's probability is, as a 0..1 "confidence" for
 * banding (SPEC §1.1: concentrated = high). Exported so publish.ts can
 * render the same confidence for `lowConfidence` findings without
 * duplicating the formula.
 */
export function noulConfidence(prob: number): number {
  // Rounded to avoid floating-point noise (e.g. |0.95-0.5|*2 === 0.8999999999999999
  // in IEEE 754) pushing a value that should land exactly on a configured
  // threshold to the wrong side of it.
  return Math.round(Math.abs(prob - 0.5) * 2 * 1e9) / 1e9;
}

export async function runFindingFilterStage(
  input: FindingFilterStageInput,
): Promise<FindingFilterStageResult> {
  const findingRecords: FindingRecord[] = [];
  for (const review of input.reviews) {
    if (review.error) continue;
    review.findings.forEach((candidate, index) => {
      findingRecords.push({
        id: `${review.hunkId}-f${index}`,
        hunkId: review.hunkId,
        datasetVersion: 2,
        reviewer: { provider: "anthropic", model: review.model ?? "unknown" },
        file: review.file,
        lineStart: candidate.lineStart,
        lineEnd: candidate.lineEnd,
        claim: candidate.claim,
        rationale: candidate.rationale,
        suggestedSeverity: candidate.suggestedSeverity,
        label: { real: false, source: "line-overlap", overlapLines: 0, fixChangedLines: 0 },
        needsManualReview: true,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
      });
    });
  }

  if (findingRecords.length === 0) {
    return {
      published: [],
      needsHuman: [],
      discarded: [],
      lowConfidence: [],
      totalRequests: 0,
      totalLatencyMs: 0,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      requestLatenciesMs: [],
    };
  }

  const run = await runFilter({
    port: input.decisionPort,
    findings: findingRecords,
    hunkDiffsById: input.hunksById,
  });

  const findingsById = new Map(findingRecords.map((f) => [f.id, f]));
  const policy = createConfidencePolicy(input.policyConfig);

  const published: FilteredFinding[] = [];
  const needsHuman: FilteredFinding[] = [];
  const discarded: FilteredFinding[] = [];
  const lowConfidence: FilteredFinding[] = [];

  const calibration = input.calibration ?? NO_CALIBRATION;

  for (const result of run.results) {
    const record = findingsById.get(result.findingId);
    if (!record) continue;

    // Calibration happens HERE, before anything reads the probability: the
    // band, the predicted-real cut and the summary comment must all see one
    // number, or the "confidence" in a comment would not be the confidence
    // that routed the finding.
    const calibratedProb = applyCalibration(calibration, result.isRealDefectProb);

    const filtered: FilteredFinding = {
      findingId: result.findingId,
      hunkId: record.hunkId,
      file: record.file,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      claim: record.claim,
      rationale: record.rationale,
      isRealDefectProb: calibratedProb,
      rawIsRealDefectProb: result.isRealDefectProb,
      jevSeverityScore: result.severity,
      isStyleOnlyProb: result.isStyleOnlyProb,
      actionableProb: result.actionableProb,
      requestId: result.requestId,
      unverified: false,
    };

    const confidence = noulConfidence(calibratedProb);
    const band = policy.band("finding_filter", input.riskLevel, confidence);
    const predictedReal = calibratedProb >= 0.5;
    // FR-5.4: "critical" by EITHER source. The reviewer's suggested severity
    // counts as much as Jev's own score: H0 showed Jev cannot judge whether
    // a defect is real, so letting its "not real" verdict silently drop a
    // finding the LLM flagged as critical is exactly the suppression the
    // adversarial suite (H5) caught — two planted criticals ended discarded
    // because Jev scored them 2.3 (major) with a confident "not real".
    const isCritical =
      jevSeverityLevel(result.severity) === "critical" || record.suggestedSeverity === "critical";

    if (band === "auto" && predictedReal) {
      published.push(filtered);
    } else if (band === "confirm" || isCritical) {
      // A critical finding is never discarded, whatever the band: the worst
      // case is one extra item in the human queue.
      needsHuman.push(filtered);
    } else if (input.mode === "discard") {
      discarded.push(filtered);
    } else {
      // "annotate" (default, product decision 2026-09-22, H1 pending):
      // never discard — keep it visible instead.
      lowConfidence.push(filtered);
    }
  }

  // NFR-2 fail-closed: a finding Jev failed to classify (timeout, error) is
  // never silently dropped — it's routed to needsHuman as "unverified",
  // same as a low-confidence "confirm" band finding.
  for (const failure of run.failures) {
    const record = findingsById.get(failure.findingId);
    if (!record) continue;
    needsHuman.push({
      findingId: failure.findingId,
      hunkId: record.hunkId,
      file: record.file,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      claim: record.claim,
      rationale: record.rationale,
      // Jev never answered, so there is no probability to calibrate: both
      // stay NaN and the finding is routed by the fail-closed rule, not by a
      // number.
      isRealDefectProb: Number.NaN,
      rawIsRealDefectProb: Number.NaN,
      jevSeverityScore: Number.NaN,
      isStyleOnlyProb: Number.NaN,
      actionableProb: Number.NaN,
      requestId: "",
      unverified: true,
    });
  }

  return {
    published,
    needsHuman,
    discarded,
    lowConfidence,
    totalRequests: run.totals.requests,
    totalLatencyMs: run.totals.totalLatencyMs,
    totalUsage: { inputTokens: run.totals.inputTokens, outputTokens: run.totals.outputTokens },
    requestLatenciesMs: requestLatencies(run.results),
  };
}

/** One latency per Jev request: results sharing a requestId came from one batched call (batch size is 1 here, kept safe anyway). */
function requestLatencies(results: readonly { requestId: string; latencyMs: number }[]): number[] {
  const seen = new Set<string>();
  const latencies: number[] = [];
  for (const result of results) {
    if (seen.has(result.requestId)) continue;
    seen.add(result.requestId);
    latencies.push(result.latencyMs);
  }
  return latencies;
}
