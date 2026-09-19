/**
 * Deterministic ReviewerPort for stage tests (SPEC §10.2 pattern, mirrors
 * ../fake-decision-adapter.ts): scripted by hunk id, either a ReviewOutput
 * to return or an Error to reject with. Throws on an unscripted hunk id so a
 * test never silently falls back to a stub answer.
 */
import type { ReviewInput, ReviewOutput, ReviewerPort } from "../../domain/ports/reviewer-port.js";

export class UnscriptedHunkError extends Error {
  constructor(hunkId: string) {
    super(`no scripted review for hunk id "${hunkId}"`);
    this.name = "UnscriptedHunkError";
  }
}

export type FakeReviewerScript = Record<string, ReviewOutput | Error>;

export function createFakeReviewer(script: FakeReviewerScript): ReviewerPort {
  return {
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const scripted = script[input.hunkId];
      if (scripted === undefined) {
        throw new UnscriptedHunkError(input.hunkId);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    },
  };
}
