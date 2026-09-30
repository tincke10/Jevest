/**
 * Deterministic DescriptionContextPort for tests, the extractor-side twin
 * of ../narrators/fake-narrator.ts: scripted by PR id (an output to return
 * or an Error to reject with), or a function of the input. Throws on an
 * unscripted PR id so a test never silently falls back to stub context.
 * `calls` records every input.
 */
import { type AuthorContext, EMPTY_AUTHOR_CONTEXT } from "../../domain/author-context.js";
import type {
  DescriptionContextInput,
  DescriptionContextOutput,
  DescriptionContextPort,
} from "../../domain/ports/description-context-port.js";

export class UnscriptedDescriptionContextError extends Error {
  constructor(prId: string) {
    super(`no scripted description context for pull request "${prId}"`);
    this.name = "UnscriptedDescriptionContextError";
  }
}

export type FakeDescriptionContextScript =
  | Record<string, DescriptionContextOutput | Error>
  | ((
      input: DescriptionContextInput,
    ) => DescriptionContextOutput | Promise<DescriptionContextOutput>);

export interface FakeDescriptionContextExtractor extends DescriptionContextPort {
  readonly calls: DescriptionContextInput[];
}

/** A zero-cost output with the given kept items and discarded paraphrases; override any field. */
export function fakeDescriptionContextOutput(
  context: Partial<AuthorContext> = {},
  discarded: readonly string[] = [],
  overrides: Partial<DescriptionContextOutput> = {},
): DescriptionContextOutput {
  return {
    context: { ...EMPTY_AUTHOR_CONTEXT, ...context },
    discarded,
    model: "fake-description-context",
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

export function createFakeDescriptionContextExtractor(
  script: FakeDescriptionContextScript,
): FakeDescriptionContextExtractor {
  const calls: DescriptionContextInput[] = [];
  return {
    calls,
    async extract(input: DescriptionContextInput): Promise<DescriptionContextOutput> {
      calls.push(input);
      if (typeof script === "function") {
        return script(input);
      }
      const scripted = script[input.prId];
      if (scripted === undefined) {
        throw new UnscriptedDescriptionContextError(input.prId);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}
