import { describe, expect, it } from "vitest";
import type { ChangeSummaryInput } from "../../domain/ports/change-summarizer-port.js";
import {
  MAX_PATCH_CHARS,
  MAX_PROMPT_CHARS,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
} from "./summary-prompt.js";

const INPUT: ChangeSummaryInput = {
  prId: "acme/shop#42",
  files: [
    {
      path: "src/checkout/total.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      patch: "@@ -1,3 +1,6 @@\n-const tax = 0;\n+const tax = subtotal * rate;",
    },
    { path: "assets/logo.png", status: "added", additions: 0, deletions: 0 },
  ],
};

describe("SUMMARY_SYSTEM_PROMPT", () => {
  it("is a non-empty English constant with no request-specific content", () => {
    expect(SUMMARY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain(INPUT.prId);
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain("src/checkout/total.ts");
  });

  it("asks for product-level behavior in any language and forbids guessing motivation", () => {
    const lowered = SUMMARY_SYSTEM_PROMPT.toLowerCase();
    expect(lowered).toMatch(/any programming language/);
    expect(lowered).toMatch(/product behavior|behavior/);
    expect(lowered).toMatch(/never guess the author's motivation/);
  });

  it("names every output field with its constraint", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("what_changes");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("behavior_changes");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("user_facing");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("breaking");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("areas");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("risks");
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/60 words/);
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toMatch(/empty/);
  });
});

describe("buildSummaryUserPrompt", () => {
  it("lists every file with status and counts, and each patch in a diff fence", () => {
    const prompt = buildSummaryUserPrompt(INPUT);
    expect(prompt).toContain("src/checkout/total.ts");
    expect(prompt).toContain("modified");
    expect(prompt).toContain("+4");
    expect(prompt).toContain("-1");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("const tax = subtotal * rate;");
  });

  it("says when a file has no patch instead of omitting the file", () => {
    const prompt = buildSummaryUserPrompt(INPUT);
    expect(prompt).toContain("assets/logo.png");
    expect(prompt).toMatch(/no patch/i);
  });

  it("never includes the pull request id, so nothing about the author leaks in", () => {
    expect(buildSummaryUserPrompt(INPUT)).not.toContain(INPUT.prId);
  });

  it("truncates a single patch to MAX_PATCH_CHARS and says so", () => {
    const longPatch = "x".repeat(MAX_PATCH_CHARS + 500);
    const prompt = buildSummaryUserPrompt({
      prId: "p",
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: longPatch }],
    });
    expect(prompt).not.toContain(longPatch);
    expect(prompt).toContain("x".repeat(MAX_PATCH_CHARS));
    expect(prompt).toMatch(/patch truncated/i);
  });

  it("caps the whole prompt near MAX_PROMPT_CHARS and notes how many files were omitted", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "y".repeat(MAX_PATCH_CHARS),
    }));
    const prompt = buildSummaryUserPrompt({ prId: "p", files });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 500);
    expect(prompt).toMatch(/omitted/i);
    expect(prompt).toContain("src/file-0.ts");
    expect(prompt).not.toContain("src/file-19.ts\n");
    expect(prompt).toMatch(/\d+ more files? omitted/i);
  });

  it("does not add an omission note when everything fits", () => {
    expect(buildSummaryUserPrompt(INPUT)).not.toMatch(/omitted/i);
  });

  it("exposes the caps as constants (6,000 per patch, 40,000 total)", () => {
    expect(MAX_PATCH_CHARS).toBe(6_000);
    expect(MAX_PROMPT_CHARS).toBe(40_000);
  });
});
