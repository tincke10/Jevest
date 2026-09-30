/**
 * Deterministic ReviewNarratorPort for tests, the narrator-side twin of
 * ../summarizers/fake-summarizer.ts: scripted by PR id (an output to return
 * or an Error to reject with), or a function of the input. Throws on an
 * unscripted PR id so a test never silently falls back to a stub review.
 * `calls` records every input, so a test can assert what the narrator was
 * (and was not) given.
 */
import type {
  ReviewNarrativeInput,
  ReviewNarrativeOutput,
  ReviewNarratorPort,
} from "../../domain/ports/review-narrator-port.js";

export class UnscriptedNarrativeError extends Error {
  constructor(prId: string) {
    super(`no scripted review narrative for pull request "${prId}"`);
    this.name = "UnscriptedNarrativeError";
  }
}

export type FakeNarratorScript =
  | Record<string, ReviewNarrativeOutput | Error>
  | ((input: ReviewNarrativeInput) => ReviewNarrativeOutput | Promise<ReviewNarrativeOutput>);

export interface FakeNarrator extends ReviewNarratorPort {
  readonly calls: ReviewNarrativeInput[];
}

/** A zero-cost output around `markdown`; override any field. */
export function fakeNarrativeOutput(
  markdown: string,
  overrides: Partial<ReviewNarrativeOutput> = {},
): ReviewNarrativeOutput {
  return {
    markdown,
    model: "fake-narrator",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 0,
    nominalCostUsd: 0,
    ...overrides,
  };
}

export function createFakeNarrator(script: FakeNarratorScript): FakeNarrator {
  const calls: ReviewNarrativeInput[] = [];
  return {
    calls,
    async narrate(input: ReviewNarrativeInput): Promise<ReviewNarrativeOutput> {
      calls.push(input);
      if (typeof script === "function") {
        return script(input);
      }
      const scripted = script[input.prId];
      if (scripted === undefined) {
        throw new UnscriptedNarrativeError(input.prId);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}
