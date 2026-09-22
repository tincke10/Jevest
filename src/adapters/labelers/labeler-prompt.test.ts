import { describe, expect, it } from "vitest";
import type { FindingLabelerInput } from "../../domain/ports/finding-labeler-port.js";
import {
  CLAIM_VERIFICATION_SYSTEM_PROMPT,
  FIX_MATCH_SYSTEM_PROMPT,
  buildLabelerUserPrompt,
  labelerSystemPromptFor,
} from "./labeler-prompt.js";

const INPUT: FindingLabelerInput = {
  findingId: "zod-9446b5c-1::claude-cli::0",
  claim: "The wrong context is passed to newVar.",
  rationale: "ctx is the outer context; the inner one is ctx2.",
  file: "packages/zod/src/v4/core/compile.ts",
  lineStart: 1268,
  lineEnd: 1268,
  hunkHeader: "@@ -1268,3 +1268,3 @@",
  language: "ts",
  before: "const outputVar = newVar(ctx);",
  after: "const outputVar = newVar(ctx2);",
  commitMessage: "fix: pass the inner context to newVar (#6585)",
  hunkIsDefect: true,
  issueTitle: "compile() crashes on nested objects",
  issueBody: "Reproduction: a nested object schema throws at runtime.",
  prTitle: "fix(compile): inner context",
  prBody: "Closes #6585.",
};

describe("labeler system prompts", () => {
  it("carry zero finding-specific content so they stay promptcacheable across the whole run", () => {
    for (const prompt of [FIX_MATCH_SYSTEM_PROMPT, CLAIM_VERIFICATION_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain(INPUT.claim);
      expect(prompt).not.toContain(INPUT.file);
      expect(prompt).not.toContain(INPUT.before);
      expect(prompt).not.toContain(INPUT.findingId);
    }
  });

  it("state their own verdict vocabulary and never the other framing's", () => {
    expect(FIX_MATCH_SYSTEM_PROMPT).toContain('"real"');
    expect(FIX_MATCH_SYSTEM_PROMPT).toContain('"not-this"');
    expect(FIX_MATCH_SYSTEM_PROMPT).toContain('"unclear"');
    expect(FIX_MATCH_SYSTEM_PROMPT).not.toContain('"present"');

    expect(CLAIM_VERIFICATION_SYSTEM_PROMPT).toContain('"present"');
    expect(CLAIM_VERIFICATION_SYSTEM_PROMPT).toContain('"absent"');
    expect(CLAIM_VERIFICATION_SYSTEM_PROMPT).toContain('"unclear"');
    expect(CLAIM_VERIFICATION_SYSTEM_PROMPT).not.toContain('"not-this"');
  });

  it("ask for a confidence and a one-sentence reason in both framings", () => {
    for (const prompt of [FIX_MATCH_SYSTEM_PROMPT, CLAIM_VERIFICATION_SYSTEM_PROMPT]) {
      expect(prompt).toContain("confidence");
      expect(prompt).toContain("reason");
    }
  });

  it("are two genuinely different framings, not the same text twice", () => {
    expect(FIX_MATCH_SYSTEM_PROMPT).not.toBe(CLAIM_VERIFICATION_SYSTEM_PROMPT);
  });

  it("labelerSystemPromptFor picks the prompt by framing", () => {
    expect(labelerSystemPromptFor("fix-match")).toBe(FIX_MATCH_SYSTEM_PROMPT);
    expect(labelerSystemPromptFor("claim-verification")).toBe(CLAIM_VERIFICATION_SYSTEM_PROMPT);
  });
});

describe("buildLabelerUserPrompt", () => {
  it("carries the before code, the fix, the commit message and the issue", () => {
    const text = buildLabelerUserPrompt(INPUT);
    expect(text).toContain(INPUT.before);
    expect(text).toContain(INPUT.after);
    expect(text).toContain(INPUT.commitMessage);
    expect(text).toContain(INPUT.issueTitle as string);
    expect(text).toContain(INPUT.issueBody as string);
    expect(text).toContain(INPUT.prTitle as string);
    expect(text).toContain(INPUT.claim);
    expect(text).toContain(INPUT.rationale);
    expect(text).toContain(INPUT.hunkHeader);
    expect(text).toContain("1268-1268");
  });

  it("never leaks the finding id, which is a fixture key and not evidence", () => {
    expect(buildLabelerUserPrompt(INPUT)).not.toContain(INPUT.findingId);
  });

  it("states whether the hunk's commit was a bugfix or a benign change", () => {
    expect(buildLabelerUserPrompt(INPUT)).toContain("bugfix");
    expect(buildLabelerUserPrompt({ ...INPUT, hunkIsDefect: false })).toContain("not a bugfix");
  });

  it("omits the issue and PR sections entirely when no evidence was fetched", () => {
    const text = buildLabelerUserPrompt({
      findingId: INPUT.findingId,
      claim: INPUT.claim,
      rationale: INPUT.rationale,
      file: INPUT.file,
      lineStart: INPUT.lineStart,
      lineEnd: INPUT.lineEnd,
      hunkHeader: INPUT.hunkHeader,
      language: INPUT.language,
      before: INPUT.before,
      after: INPUT.after,
      commitMessage: INPUT.commitMessage,
      hunkIsDefect: true,
    });
    expect(text).not.toContain("Linked issue");
    expect(text).not.toContain("Linked pull request");
  });

  it("is identical for both framings: only the system prompt differs", () => {
    expect(buildLabelerUserPrompt(INPUT)).toBe(buildLabelerUserPrompt({ ...INPUT }));
  });
});
