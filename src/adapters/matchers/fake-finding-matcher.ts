/** Scripted FindingMatcherPort for tests: `decide` returns an issue id or `null`. */
import type {
  FindingMatchInput,
  FindingMatcherPort,
} from "../../domain/ports/finding-matcher-port.js";

export function createFakeFindingMatcher(
  decide: (input: FindingMatchInput) => string | null,
  costUsd = 0,
): FindingMatcherPort {
  return {
    async match(input) {
      return { issueId: decide(input), costUsd };
    },
  };
}
