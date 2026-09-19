/**
 * Confidence bands (SPEC §1.1, NFR-13): resolves calibrated confidence into
 * one of three actions — automate, ask for confirmation, or escalate to a
 * human — using thresholds that live in configuration, never hardcoded here,
 * per stage (triage, hunk_profile, finding_filter, merge_gate) and risk level.
 */

export type Band = "auto" | "confirm" | "escalate";

/** Confidence thresholds for one (stage, risk) pair. */
export interface ConfidenceThresholds {
  /** confidence >= autoMin resolves to "auto". */
  readonly autoMin: number;
  /** confidence >= confirmMin (and below autoMin) resolves to "confirm"; below it, "escalate". */
  readonly confirmMin: number;
}

/** Thresholds keyed by stage, then by risk level. */
export type ConfidencePolicyConfig = Record<string, Record<string, ConfidenceThresholds>>;

export class ConfidencePolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfidencePolicyConfigError";
  }
}

export interface ConfidencePolicy {
  /**
   * Resolves a confidence value into a band for the given stage and risk level.
   * @throws {ConfidencePolicyConfigError} No thresholds are configured for the (stage, risk) pair.
   * @throws {RangeError} `confidence` is outside [0, 1].
   */
  readonly band: (stage: string, risk: string, confidence: number) => Band;
}

export function createConfidencePolicy(config: ConfidencePolicyConfig): ConfidencePolicy {
  return {
    band(stage: string, risk: string, confidence: number): Band {
      if (confidence < 0 || confidence > 1) {
        throw new RangeError(`confidence must be between 0 and 1, got ${confidence}`);
      }

      const stageConfig = config[stage];
      if (!stageConfig) {
        throw new ConfidencePolicyConfigError(
          `no confidence policy configured for stage "${stage}"`,
        );
      }

      const thresholds = stageConfig[risk];
      if (!thresholds) {
        throw new ConfidencePolicyConfigError(
          `no confidence policy configured for stage "${stage}" and risk level "${risk}"`,
        );
      }

      if (confidence >= thresholds.autoMin) {
        return "auto";
      }
      if (confidence >= thresholds.confirmMin) {
        return "confirm";
      }
      return "escalate";
    },
  };
}
