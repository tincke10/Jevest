/**
 * The matcher flags shared by `pnpm eval:review` and `pnpm eval:rescore`
 * (docs/EVAL.md "Matching"): `--matcher llm|claude-cli|prefilter`,
 * `--matcher-model`, `--matcher-effort`, and the cached claude-cli matcher
 * they build.
 */
import { join } from "node:path";
import { AGENT_EFFORT_LEVELS, type AgentEffort } from "../../src/adapters/config/jevest-config.js";
import {
  MATCHER_CACHE_VERSION,
  createCachedFindingMatcher,
} from "../../src/adapters/matchers/cached-finding-matcher.js";
import {
  CLAUDE_CLI_MATCHER_DEFAULT_EFFORT,
  CLAUDE_CLI_MATCHER_DEFAULT_MODEL,
  createClaudeCliFindingMatcher,
} from "../../src/adapters/matchers/claude-cli-finding-matcher.js";
import { createTopPrefilterMatcher } from "../../src/application/eval/match-candidates.js";
import type { FindingMatcherPort } from "../../src/domain/ports/finding-matcher-port.js";

/** `llm` is an alias of `claude-cli`, the LLM matcher. */
export type MatcherKind = "claude-cli" | "prefilter";
const MATCHER_FLAG_VALUES = ["llm", "claude-cli", "prefilter"] as const;

export const DEFAULT_MATCHER_MODEL = CLAUDE_CLI_MATCHER_DEFAULT_MODEL;
export const DEFAULT_MATCHER_EFFORT = CLAUDE_CLI_MATCHER_DEFAULT_EFFORT;

export function parseMatcherKind(value: string): MatcherKind {
  if (!(MATCHER_FLAG_VALUES as readonly string[]).includes(value)) {
    throw new Error(`--matcher must be one of ${MATCHER_FLAG_VALUES.join(", ")}, got "${value}"`);
  }
  return value === "prefilter" ? "prefilter" : "claude-cli";
}

export function parseMatcherEffort(value: string): AgentEffort {
  if (!(AGENT_EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `--matcher-effort must be one of ${AGENT_EFFORT_LEVELS.join(", ")}, got "${value}"`,
    );
  }
  return value as AgentEffort;
}

export function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export interface MatcherOptions {
  readonly matcher: MatcherKind;
  readonly matcherModel: string;
  readonly matcherEffort: AgentEffort;
}

/** The matcher and its `results.json` description; decisions cached under `<outDir>/matcher-cache/`. */
export function buildMatcher(
  options: MatcherOptions,
  outDir: string,
): { matcher: FindingMatcherPort; info: Record<string, unknown> } {
  if (options.matcher === "prefilter") {
    return { matcher: createTopPrefilterMatcher(), info: { type: "prefilter" } };
  }
  return {
    matcher: createCachedFindingMatcher({
      inner: createClaudeCliFindingMatcher({
        model: options.matcherModel,
        effort: options.matcherEffort,
      }),
      dir: join(outDir, "matcher-cache"),
      model: options.matcherModel,
      effort: options.matcherEffort,
    }),
    info: {
      type: "claude-cli",
      model: options.matcherModel,
      effort: options.matcherEffort,
      cacheVersion: MATCHER_CACHE_VERSION,
    },
  };
}
