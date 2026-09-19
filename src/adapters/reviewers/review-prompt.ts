/**
 * Shared reviewer prompt (SPEC FR-4, §5 Fase 1a step 1). Both the Anthropic
 * and OpenAI adapters use the same instructions so H1/H6 compare the
 * reviewer, not the prompt. Written in English per NFR-8. The system prompt
 * is a plain constant with zero hunk-specific content — everything about a
 * particular hunk goes in the per-request user message so the system prompt
 * stays cacheable across all hunks (see prompt caching in anthropic-reviewer.ts).
 */
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
