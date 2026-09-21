/**
 * Deterministic ChangeSummarizerPort for tests, the summarizer-side twin of
 * ../reviewers/fake-reviewer.ts: scripted by PR id (a ChangeSummaryOutput to
 * return or an Error to reject with), or a function that computes the output
 * from the input. Throws on an unscripted PR id so a test never silently
 * falls back to a stub answer.
 */
import type {
  ChangeSummarizerPort,
  ChangeSummaryInput,
  ChangeSummaryOutput,
} from "../../domain/ports/change-summarizer-port.js";

export class UnscriptedPrError extends Error {
  constructor(prId: string) {
    super(`no scripted summary for pull request "${prId}"`);
    this.name = "UnscriptedPrError";
  }
}

export type FakeSummarizerScript =
  | Record<string, ChangeSummaryOutput | Error>
  | ((input: ChangeSummaryInput) => ChangeSummaryOutput | Promise<ChangeSummaryOutput>);

export function createFakeSummarizer(script: FakeSummarizerScript): ChangeSummarizerPort {
  return {
    async summarize(input: ChangeSummaryInput): Promise<ChangeSummaryOutput> {
      if (typeof script === "function") {
        return script(input);
      }
      const scripted = script[input.prId];
      if (scripted === undefined) {
        throw new UnscriptedPrError(input.prId);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}
