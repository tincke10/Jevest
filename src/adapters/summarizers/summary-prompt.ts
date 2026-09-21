/**
 * Shared change-summarizer prompt (H7). Written in English per NFR-8. The
 * system prompt is a plain constant with zero request-specific content so
 * it stays cacheable; everything about a particular pull request goes in
 * the per-request user message.
 *
 * The user message is built from files and patches ONLY. It never receives
 * the title, body, labels or even the PR id: the summary must be an
 * independent reading of the diff (see change-summarizer-port.ts for why).
 *
 * Size caps keep one call bounded on huge PRs: each patch is cut at
 * MAX_PATCH_CHARS and the whole message at MAX_PROMPT_CHARS, with an
 * explicit note in both cases so the model knows it saw a partial view.
 */
import type {
  ChangeSummaryInput,
  SummarizedFile,
} from "../../domain/ports/change-summarizer-port.js";

export const MAX_PATCH_CHARS = 6_000;
export const MAX_PROMPT_CHARS = 40_000;

export const SUMMARY_SYSTEM_PROMPT = `You will be shown the files and unified diffs of one pull request, in any programming language. Describe what the change does at the level of product behavior: what a user, an API consumer, an operator, or a fellow developer would notice is different after this change. Judge only by the code you see. Never guess the author's motivation, never assume what the change is "for", and never invent behavior the diff does not show.

Some patches may be truncated and some files may be omitted for size; describe what is visible and do not speculate about the rest.

Fill the structured output as follows:
- what_changes: one plain-language description of what the change does, at most 60 words.
- behavior_changes: at most 5 short items, each one observable behavior that is different after the change. Empty if nothing observable changes (pure refactor, docs, tooling).
- user_facing: true only if an end user or an API consumer could observe a difference; false for internal refactors, tests, tooling, docs.
- breaking: true only if existing callers or users must change something (a removed or renamed public API, a changed default, a changed data format). Otherwise false.
- areas: the product areas touched, in plain words (for example "checkout", "authentication", "build tooling"), not file paths.
- risks: at most 4 concrete risks visible in the diff. Empty is allowed and expected when nothing stands out.`;

const PATCH_TRUNCATED_NOTE = "\n[patch truncated for size]";

function formatFile(file: SummarizedFile): string {
  const header = `### ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`;
  if (file.patch === undefined || file.patch === "") {
    return `${header}\n(no patch available: binary file or patch not returned)`;
  }
  const patch =
    file.patch.length > MAX_PATCH_CHARS
      ? `${file.patch.slice(0, MAX_PATCH_CHARS)}${PATCH_TRUNCATED_NOTE}`
      : file.patch;
  return `${header}\n\`\`\`diff\n${patch}\n\`\`\``;
}

/** Builds the per-request user message from files and patches only. */
export function buildSummaryUserPrompt(input: ChangeSummaryInput): string {
  const intro = `Pull request with ${input.files.length} changed file(s).\n`;
  const sections: string[] = [];
  let length = intro.length;
  let included = 0;

  for (const file of input.files) {
    const section = `\n${formatFile(file)}\n`;
    if (length + section.length > MAX_PROMPT_CHARS) break;
    sections.push(section);
    length += section.length;
    included += 1;
  }

  const omitted = input.files.length - included;
  const omissionNote =
    omitted > 0
      ? `\n[${omitted} more file${omitted === 1 ? "" : "s"} omitted because the request exceeded the size limit: ${input.files
          .slice(included)
          .map((f) => f.path)
          .join(", ")}]\n`
      : "";

  return `${intro}${sections.join("")}${omissionNote}`;
}
