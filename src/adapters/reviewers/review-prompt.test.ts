import { describe, expect, it } from "vitest";
import type { ReviewInput } from "../../domain/ports/reviewer-port.js";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT_THOROUGH,
  buildReviewUserPrompt,
  reviewSystemPromptFor,
} from "./review-prompt.js";

const SAMPLE_INPUT: ReviewInput = {
  hunkId: "zod-9446b5c-1",
  file: "packages/zod/src/v4/core/compile.ts",
  language: "typescript",
  hunkHeader: "@@ -1268,13 +1268,13 @@ function generateObjectCheck(",
  before: "const outputVar = newVar(ctx);",
  diff: "@@ -1268,13 +1268,13 @@\n-const outputVar = newVar(ctx);\n+const outputVar = newVar(ctx2);",
};

describe("REVIEW_SYSTEM_PROMPT", () => {
  it("is a non-empty constant string", () => {
    expect(typeof REVIEW_SYSTEM_PROMPT).toBe("string");
    expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("contains no hunk-specific content from a sample input", () => {
    expect(REVIEW_SYSTEM_PROMPT).not.toContain(SAMPLE_INPUT.hunkId);
    expect(REVIEW_SYSTEM_PROMPT).not.toContain(SAMPLE_INPUT.file);
    expect(REVIEW_SYSTEM_PROMPT).not.toContain(SAMPLE_INPUT.hunkHeader);
    expect(REVIEW_SYSTEM_PROMPT).not.toContain(SAMPLE_INPUT.before);
    expect(REVIEW_SYSTEM_PROMPT).not.toContain(SAMPLE_INPUT.diff);
  });

  it("instructs the reviewer to look for concrete defects, not style", () => {
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(/logic|boundary|async|error handling/);
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(/style|formatting|naming/);
  });

  it("instructs the reviewer that an empty findings list is a valid answer", () => {
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(/empty/);
  });

  it("instructs the reviewer to use absolute before-side line numbers", () => {
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(/absolute/);
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(/before/);
  });

  it("is identical across accesses (a plain constant, not a per-call template)", () => {
    expect(REVIEW_SYSTEM_PROMPT).toBe(REVIEW_SYSTEM_PROMPT);
  });
});

describe("buildReviewUserPrompt", () => {
  it("includes the file, language, hunk header, before code, and diff", () => {
    const prompt = buildReviewUserPrompt(SAMPLE_INPUT);
    expect(prompt).toContain(SAMPLE_INPUT.file);
    expect(prompt).toContain(SAMPLE_INPUT.language);
    expect(prompt).toContain(SAMPLE_INPUT.hunkHeader);
    expect(prompt).toContain(SAMPLE_INPUT.before);
    expect(prompt).toContain(SAMPLE_INPUT.diff);
  });

  it("includes the profile as context when provided", () => {
    const prompt = buildReviewUserPrompt({
      ...SAMPLE_INPUT,
      profile: { change_kind: "modify-behavior", touches_public_api: true },
    });
    expect(prompt).toContain("modify-behavior");
    expect(prompt).toContain("touches_public_api");
  });

  it("omits any profile section when no profile is given", () => {
    const prompt = buildReviewUserPrompt(SAMPLE_INPUT);
    expect(prompt.toLowerCase()).not.toContain("profile");
  });
});

describe("REVIEW_SYSTEM_PROMPT_THOROUGH", () => {
  it("is a distinct non-empty constant that keeps the strict prompt's structure", () => {
    expect(typeof REVIEW_SYSTEM_PROMPT_THOROUGH).toBe("string");
    expect(REVIEW_SYSTEM_PROMPT_THOROUGH).not.toBe(REVIEW_SYSTEM_PROMPT);
    const lower = REVIEW_SYSTEM_PROMPT_THOROUGH.toLowerCase();
    expect(lower).toMatch(/logic|boundary|async|error handling/);
    expect(lower).toMatch(/absolute/);
    expect(lower).toMatch(/before/);
  });

  it("lowers the bar: report plausible or suspected issues, prefer reporting over silence, one finding per location", () => {
    const lower = REVIEW_SYSTEM_PROMPT_THOROUGH.toLowerCase();
    expect(lower).toMatch(/plausible|suspected/);
    expect(lower).toMatch(/not sure|unsure|uncertain/);
    expect(lower).toMatch(/prefer reporting/);
    expect(lower).toMatch(/one finding per/);
  });

  it("contains no hunk-specific content from a sample input", () => {
    expect(REVIEW_SYSTEM_PROMPT_THOROUGH).not.toContain(SAMPLE_INPUT.hunkId);
    expect(REVIEW_SYSTEM_PROMPT_THOROUGH).not.toContain(SAMPLE_INPUT.diff);
  });
});

describe("reviewSystemPromptFor", () => {
  it("maps strict to the strict prompt and thorough to the thorough prompt", () => {
    expect(reviewSystemPromptFor("strict")).toBe(REVIEW_SYSTEM_PROMPT);
    expect(reviewSystemPromptFor("thorough")).toBe(REVIEW_SYSTEM_PROMPT_THOROUGH);
  });
});
