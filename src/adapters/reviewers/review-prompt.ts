/**
 * Shared reviewer prompt (SPEC FR-4, §5 Fase 1a step 1). Both the Anthropic
 * and OpenAI adapters use the same instructions so H1/H6 compare the
 * reviewer, not the prompt. Written in English per NFR-8. The system prompt
 * is a plain constant with zero hunk-specific content — everything about a
 * particular hunk goes in the per-request user message so the system prompt
 * stays cacheable across all hunks (see prompt caching in anthropic-reviewer.ts).
 */
import type { ReviewPromptMode } from "../../domain/finding.js";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";

export const REVIEW_SYSTEM_PROMPT = `You are a precise code reviewer. You will be shown one hunk of a code change: its file path, language, the code before the change, and the unified diff.

Report only concrete defects you can point to specific lines for:
- logic errors (wrong condition, off-by-one, boundary mistakes)
- async/concurrency issues (missing await, unhandled rejection, race condition)
- error handling gaps (swallowed error, wrong error type, missing cleanup on failure)
- type misuse (unsafe cast, wrong null/undefined handling)

Do NOT report style, formatting, naming, or other purely subjective preferences — those are out of scope for this review.

Every finding's line_start and line_end must be absolute line numbers on the BEFORE side of the diff (the file as it existed before this change), computed from the hunk header shown in the user message, not from the diff's own +/- line offsets.

If you find no concrete defect, return an empty findings list. Do not invent an issue just to have something to say — an empty list is a valid and expected answer.`;

/**
 * Thorough variant (2026-09-21, SPEC §13): same structure, same output
 * schema, same line-number rules, but a deliberately LOW bar. The strict
 * pass over the 100 hunks produced only 14 findings (9 real / 5 noise),
 * far too little noise to measure whether the filter discards any (H1).
 * This prompt exists to generate a findings set with a real/noise mix; it
 * is not the production reviewer.
 */
export const REVIEW_SYSTEM_PROMPT_THOROUGH = `You are a thorough code reviewer. You will be shown one hunk of a code change: its file path, language, the code before the change, and the unified diff.

Report every plausible or suspected issue you can point to specific lines for, including minor ones and ones you are not sure about. Prefer reporting over silence: if something looks off, report it and say in the rationale how confident you are. Look for, among others:
- logic errors (wrong condition, off-by-one, boundary mistakes)
- async/concurrency issues (missing await, unhandled rejection, race condition)
- error handling gaps (swallowed error, wrong error type, missing cleanup on failure)
- type misuse (unsafe cast, wrong null/undefined handling)
- edge cases the change may not handle (empty input, unicode, very large values, unexpected shapes)
- behavior changes that could surprise existing callers

Style, formatting, naming, and comment-only remarks are still out of scope: report only things that could affect what the code does.

Report one finding per concrete location: do not repeat the same issue for several line ranges, and do not merge unrelated issues into one finding.

Every finding's line_start and line_end must be absolute line numbers on the BEFORE side of the diff (the file as it existed before this change), computed from the hunk header shown in the user message, not from the diff's own +/- line offsets.

An empty findings list is allowed only when you genuinely see nothing worth a second look.`;

/** Picks the system prompt for a prompt mode; "strict" is the unchanged default. */
export function reviewSystemPromptFor(mode: ReviewPromptMode): string {
  return mode === "thorough" ? REVIEW_SYSTEM_PROMPT_THOROUGH : REVIEW_SYSTEM_PROMPT;
}

function formatProfile(profile: Record<string, unknown>): string {
  return `\n\nHunk profile (context from an earlier surface-level pass, not a defect claim):\n${JSON.stringify(profile, null, 2)}`;
}

/** Builds the per-hunk user message. Everything hunk-specific lives here, never in the system prompt. */
export function buildReviewUserPrompt(input: ReviewInput): string {
  const profileSection = input.profile ? formatProfile(input.profile) : "";
  return `File: ${input.file} (${input.language})
Hunk header: ${input.hunkHeader}

Code before the change:
\`\`\`${input.language}
${input.before}
\`\`\`

Unified diff:
\`\`\`diff
${input.diff}
\`\`\`${profileSection}`;
}
