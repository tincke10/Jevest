/**
 * Deterministic FindingLabelerPort for tests and dry runs, the labeler-side
 * twin of ../judges/fake-finding-judge.ts: scripted either by a function of
 * (input, framing) or by a record keyed `${findingId}::${framing}` (an output
 * to return or an Error to reject with). Throws on an unscripted key so a
 * test never silently gets a stub oracle label — a fabricated ground truth
 * that looks real is the one failure mode this whole module exists to avoid.
 *
 * The seeded dry-run script lives in
 * ../../application/findings/dry-run-labeler-script.ts, the same split the
 * judge uses (fake adapter here, dry-run script in the application layer).
 */
import type {
  ClaimVerificationOutput,
  FindingLabelerInput,
  FindingLabelerOutput,
  FindingLabelerPort,
  FixMatchOutput,
  LabelerFraming,
} from "../../domain/ports/finding-labeler-port.js";

export class UnscriptedLabelError extends Error {
  constructor(findingId: string, framing: LabelerFraming) {
    super(`no scripted ${framing} label for finding "${findingId}"`);
    this.name = "UnscriptedLabelError";
  }
}

export type FakeFindingLabelerScript =
  | Record<string, FindingLabelerOutput | Error>
  | ((
      input: FindingLabelerInput,
      framing: LabelerFraming,
    ) => FindingLabelerOutput | Promise<FindingLabelerOutput>);

/** The record-script key: a finding gets one entry per framing. */
export function fakeLabelerScriptKey(findingId: string, framing: LabelerFraming): string {
  return `${findingId}::${framing}`;
}

export function createFakeFindingLabeler(script: FakeFindingLabelerScript): FindingLabelerPort {
  async function label(
    input: FindingLabelerInput,
    framing: LabelerFraming,
  ): Promise<FindingLabelerOutput> {
    if (typeof script === "function") {
      return script(input, framing);
    }
    const scripted = script[fakeLabelerScriptKey(input.findingId, framing)];
    if (scripted === undefined) {
      throw new UnscriptedLabelError(input.findingId, framing);
    }
    if (scripted instanceof Error) {
      throw scripted;
    }
    return scripted;
  }

  return {
    async labelFixMatch(input) {
      return (await label(input, "fix-match")) as FixMatchOutput;
    },
    async labelClaimVerification(input) {
      return (await label(input, "claim-verification")) as ClaimVerificationOutput;
    },
  };
}
