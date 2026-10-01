/**
 * Deterministic AgenticReviewerPort and FindingVerifierPort for tests and
 * dry runs: scripted findings / decisions, fixed usage, never a process.
 */
import type { AgenticFinding } from "../../domain/agentic-finding.js";
import type { VerifierDecision } from "../../domain/agentic-policy.js";
import type {
  AgentRunInfo,
  AgentToolCall,
  AgenticReviewInput,
  AgenticReviewerPort,
} from "../../domain/ports/agentic-reviewer-port.js";
import type {
  FindingVerificationInput,
  FindingVerifierPort,
} from "../../domain/ports/finding-verifier-port.js";

export function fakeAgentRunInfo(overrides: Partial<AgentRunInfo> = {}): AgentRunInfo {
  return {
    model: "fake-agent",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    latencyMs: 10,
    nominalCostUsd: 0.1,
    turns: 3,
    toolCalls: [] as AgentToolCall[],
    ...overrides,
  };
}

export interface FakeAgenticReviewer extends AgenticReviewerPort {
  readonly calls: AgenticReviewInput[];
}

/** Returns `findings` (or throws `error`) on every call and records the inputs. */
export function createFakeAgenticReviewer(
  findings: readonly AgenticFinding[] = [],
  options: { readonly error?: Error; readonly info?: Partial<AgentRunInfo> } = {},
): FakeAgenticReviewer {
  const calls: AgenticReviewInput[] = [];
  return {
    calls,
    async reviewPullRequest(input) {
      calls.push(input);
      if (options.error) throw options.error;
      return { ...fakeAgentRunInfo(options.info), findings };
    },
  };
}

export interface FakeFindingVerifier extends FindingVerifierPort {
  readonly calls: FindingVerificationInput[];
}

/** Answers with `decide(input)` (an Error is thrown) and records the inputs. */
export function createFakeFindingVerifier(
  decide: (input: FindingVerificationInput) => VerifierDecision | Error = () => "confirmed",
  info: Partial<AgentRunInfo> = {},
): FakeFindingVerifier {
  const calls: FindingVerificationInput[] = [];
  return {
    calls,
    async verify(input) {
      calls.push(input);
      const decision = decide(input);
      if (decision instanceof Error) throw decision;
      return { ...fakeAgentRunInfo(info), decision, reason: `fake ${decision}`, evidence: [] };
    },
  };
}
