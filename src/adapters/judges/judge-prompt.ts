/**
 * LLM-judge prompt for the finding-filter baseline (H6, FR-8.3). Written
 * in English per NFR-8. The system prompt is a plain constant with zero
 * finding-specific content so it stays cacheable across every finding;
 * the per-request user message carries exactly the Jev state for one
 * finding (finding-questions.ts `buildFindingState`): hunk diff, claim,
 * rationale, file and lines. Nothing else, so the judge and Jev are
 * compared on the same information.
 *
 * The four questions are the filter question set restated in prose, with
 * the same criteria text so the rubric is identical, not merely similar.
 */
import type { FindingJudgeInput } from "../../domain/ports/finding-judge-port.js";

export const JUDGE_SYSTEM_PROMPT = `You are judging one code-review finding about one hunk of a code change. You will be shown the hunk's unified diff and the finding: its file, line range, claim and rationale. Judge only by what the hunk and the finding show; do not assume anything about code you cannot see.

Answer four questions in the structured output:

1. is_real_defect_probability (number from 0 to 1): the probability that the hunk actually has the problem the claim describes. 1 means the hunk clearly contains the specific problem and it is visible in the code shown; 0 means the claim is wrong, speculative, or about something the hunk does not show. Use the full range: 0.5 means you genuinely cannot tell.

2. severity (one of "nit", "minor", "major", "critical"): if the claim is correct, how severe is the problem it describes?
- nit: a style or preference matter with no effect on correctness, such as naming or formatting.
- minor: a real but low-impact issue, such as a slightly unclear pattern or a rare, low-consequence edge case.
- major: an issue that plausibly causes incorrect behavior for realistic inputs, or a genuine correctness or maintainability risk.
- critical: an issue that would cause a crash, data loss, a security vulnerability, or clearly incorrect behavior in the common case.

3. is_style_only (boolean): true only if the claim is purely about style, naming, formatting, or comments, with no effect on behavior; false if it is about behavior, correctness, or something that could affect what the code does.

4. actionable (boolean): true if, assuming the claim is correct, the rationale points to a specific location and problem clearly enough that a developer could write a fix directly from it; false if it is vague, generic, or would need further investigation first.`;

/** Builds the per-finding user message from the Jev state only; the finding id never appears. */
export function buildJudgeUserPrompt(input: FindingJudgeInput): string {
  return `Hunk (unified diff):
\`\`\`diff
${input.hunkDiff}
\`\`\`

Finding:
- File: ${input.file}
- Lines: ${input.lineStart}-${input.lineEnd}
- Claim: ${input.claim}
- Rationale: ${input.rationale}`;
}
