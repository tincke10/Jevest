/**
 * Prompts for the fix-aware oracle labeler (datasets/FINDINGS.md §10),
 * written in English per NFR-8 and shaped like ../judges/judge-prompt.ts: a
 * system prompt per framing that is a plain constant with zero
 * finding-specific content (so it prompt-caches across all 299 findings),
 * plus one per-request user message carrying the state.
 *
 * The user message is IDENTICAL for the two framings on purpose. The whole
 * value of the two passes comes from asking two genuinely different questions
 * about the same evidence; if the evidence differed too, a disagreement would
 * no longer mean "the two readings conflict", it would mean "they were shown
 * different things".
 *
 * What the labeler is never shown: the line-overlap label, Jev's answers, the
 * judge's answers. It gets the fix and the fix's paper trail instead, which
 * neither scored side ever had.
 */
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";

/**
 * Pass A. Anchored on the fix: of all the things one could say about this
 * code, does the finding name the one the commit actually addressed?
 */
export const FIX_MATCH_SYSTEM_PROMPT = `You are building ground truth for a code-review benchmark. You will be shown one hunk of code BEFORE a change, the same code AFTER the change, the message of the commit that made the change, and — when the project linked one — the issue or pull request behind it. You will also be shown one finding that a code reviewer wrote about the BEFORE code. That reviewer never saw the change, the commit message or the issue. You do.

Your question is narrow: does the finding describe the same problem this change fixed?

Answer with one verdict:
- "real": the finding names the problem the change fixed. The root cause or the wrong behavior it describes is the one the fix addressed. It does not have to use the same words, cite the same line, or propose the same fix — it has to be about the same defect.
- "not-this": the finding is not about the problem this change fixed. It may point at the same lines and still be "not-this": pointing at the right place for a different reason is not a match. If the change was not a bugfix at all, the correct verdict is "not-this".
- "unclear": you cannot tell from what you were shown. Use this when the finding describes something plausible that the fix simply does not speak to, or when the fix is too opaque to tell what it was for.

Guidance:
- Reason from the difference between the before and the after code first; use the commit message and the issue to confirm what that difference was for.
- Do not reward vagueness. A finding so generic that it would "match" any fix is "not-this", not "real".
- Do not punish a finding for landing a few lines away from the change, or for describing a symptom rather than the mechanism, as long as it is the same defect.
- "unclear" is a real answer, not a failure. Prefer it over guessing.

Also give a confidence from 0 to 1 in your own verdict, and a reason of one sentence naming the specific thing that decided it.`;

/**
 * Pass B. Anchored on the claim: forget what the fix was for, just check
 * whether the thing the reviewer asserts is actually in the code.
 */
export const CLAIM_VERIFICATION_SYSTEM_PROMPT = `You are building ground truth for a code-review benchmark. You will be shown one hunk of code BEFORE a change, the same code AFTER the change, the message of the commit that made the change, and — when the project linked one — the issue or pull request behind it. You will also be shown one finding that a code reviewer wrote about the BEFORE code. That reviewer never saw the change, the commit message or the issue. You do.

Your question is narrow: is the problem the finding claims actually present in the BEFORE code?

Judge the claim on its own merits. Whether the change fixed this particular problem is not the question — the after code, the commit message and the issue are here as evidence about what the before code really did, nothing more.

Answer with one verdict:
- "present": the before code really has the problem the claim describes. The evidence supports it: you can point at the mechanism in the before code, or the fix and its paper trail confirm the behavior the claim asserts.
- "absent": the claim is false about the before code. The described problem is not there — the code already handles the case, the claim misreads what the code does, or the after code and the message show the behavior was never what the claim assumes.
- "unclear": you cannot verify it from what you were shown. Use this when confirming or refuting the claim would need code outside this hunk, or when the claim is too vague to be either true or false.

Guidance:
- A claim that is true but trivial is still "present". Severity is not your question.
- A claim that is speculative ("this could break if...") is "present" only if the condition it names is genuinely reachable in the before code as shown; otherwise "unclear".
- "unclear" is a real answer, not a failure. Prefer it over guessing.

Also give a confidence from 0 to 1 in your own verdict, and a reason of one sentence naming the specific thing that decided it.`;

export function labelerSystemPromptFor(framing: "fix-match" | "claim-verification"): string {
  return framing === "fix-match" ? FIX_MATCH_SYSTEM_PROMPT : CLAIM_VERIFICATION_SYSTEM_PROMPT;
}

function section(title: string, body: string | undefined): string {
  return body === undefined || body.trim() === "" ? "" : `\n\n${title}:\n${body}`;
}

/**
 * Builds the per-finding user message. The finding id never appears: it is a
 * fixture key, not evidence, and a model that saw dataset ids could pattern
 * match on them.
 */
export function buildLabelerUserPrompt(input: FindingLabelerInput): string {
  const commitKind = input.hunkIsDefect
    ? "The project's own metadata says this commit was a bugfix."
    : "The project's own metadata says this commit was not a bugfix (no fix marker, no linked issue).";

  return `File: ${input.file} (${input.language})
Hunk: ${input.hunkHeader}
${commitKind}

Code BEFORE the change:
\`\`\`${input.language}
${input.before}
\`\`\`

Code AFTER the change:
\`\`\`${input.language}
${input.after}
\`\`\`

Commit message:
${input.commitMessage}${section("Linked issue", input.issueTitle === undefined ? undefined : `${input.issueTitle}\n${input.issueBody ?? ""}`.trim())}${section("Linked pull request", input.prTitle === undefined ? undefined : `${input.prTitle}\n${input.prBody ?? ""}`.trim())}

The reviewer's finding about the BEFORE code:
- Lines: ${input.lineStart}-${input.lineEnd}
- Claim: ${input.claim}
- Rationale: ${input.rationale}`;
}
