/**
 * Deterministic FindingJudgePort for tests, the judge-side twin of
 * ../summarizers/fake-summarizer.ts: scripted by finding id (an output to
 * return or an Error to reject with), or a function computing the output
 * from the input. Throws on an unscripted finding id so a test never
 * silently falls back to a stub answer.
 */
import type {
  FindingJudgeInput,
  FindingJudgeOutput,
  FindingJudgePort,
} from "../../domain/ports/finding-judge-port.js";

export class UnscriptedFindingError extends Error {
  constructor(findingId: string) {
    super(`no scripted judgment for finding "${findingId}"`);
    this.name = "UnscriptedFindingError";
  }
}

export type FakeFindingJudgeScript =
  | Record<string, FindingJudgeOutput | Error>
  | ((input: FindingJudgeInput) => FindingJudgeOutput | Promise<FindingJudgeOutput>);

export function createFakeFindingJudge(script: FakeFindingJudgeScript): FindingJudgePort {
  return {
    async judge(input: FindingJudgeInput): Promise<FindingJudgeOutput> {
      if (typeof script === "function") {
        return script(input);
      }
      const scripted = script[input.findingId];
      if (scripted === undefined) {
        throw new UnscriptedFindingError(input.findingId);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}
