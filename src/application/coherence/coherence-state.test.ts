import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../domain/json.js";
import type { ChangeSummary } from "../../domain/ports/change-summarizer-port.js";
import { describeChange } from "./change-facts.js";
import { MAX_BODY_CHARS, buildCoherenceState } from "./coherence-state.js";
import type { PrFile } from "./pr-record.js";

const FILES: readonly PrFile[] = [
  { path: "src/checkout/total.ts", status: "modified", additions: 400, deletions: 20 },
  { path: "src/checkout/total.test.ts", status: "added", additions: 50, deletions: 0 },
  { path: "README.md", status: "modified", additions: 2, deletions: 1 },
];

const INTENT = {
  title: "Apply tax to checkout totals",
  body: "Totals ignored tax. This applies the configured rate.",
  labels: ["bug", "checkout"],
};

const SUMMARY: ChangeSummary = {
  whatChanges: "Applies the tax rate to the checkout subtotal.",
  behaviorChanges: ["Checkout totals now include tax."],
  userFacing: true,
  breaking: false,
  areas: ["checkout"],
  risks: ["Rounding differences on existing orders."],
};

function build(overrides: Partial<Parameters<typeof buildCoherenceState>[0]> = {}): JsonObject {
  return buildCoherenceState({
    intent: INTENT,
    change: describeChange(FILES),
    summary: SUMMARY,
    ...overrides,
  });
}

describe("buildCoherenceState", () => {
  it("has three sections with snake_case keys and a note on each", () => {
    const state = build();
    expect(Object.keys(state)).toEqual(["intent", "change_facts", "change_summary"]);
    const intent = state.intent as JsonObject;
    const facts = state.change_facts as JsonObject;
    const summary = state.change_summary as JsonObject;
    expect(intent.note).toMatch(/written by the pull request author/i);
    expect(intent.note).toMatch(/may be inaccurate/i);
    expect(facts.note).toMatch(/computed from file paths and line counts/i);
    expect(summary.note).toMatch(/did not see the description/i);
  });

  it("carries title, body and labels verbatim when the body is short", () => {
    const intent = build().intent as JsonObject;
    expect(intent.title).toBe(INTENT.title);
    expect(intent.body).toBe(INTENT.body);
    expect(intent.body_truncated).toBe(false);
    expect(intent.labels).toEqual(["bug", "checkout"]);
  });

  it("truncates the body to MAX_BODY_CHARS and flags it", () => {
    const longBody = "b".repeat(MAX_BODY_CHARS + 100);
    const intent = build({ intent: { ...INTENT, body: longBody } }).intent as JsonObject;
    expect(MAX_BODY_CHARS).toBe(1_500);
    expect((intent.body as string).length).toBe(MAX_BODY_CHARS);
    expect(intent.body_truncated).toBe(true);
  });

  it("gives the size as a word, never as raw line totals", () => {
    const facts = build().change_facts as JsonObject;
    expect(facts.size).toBe("large");
    expect(facts).not.toHaveProperty("additions");
    expect(facts).not.toHaveProperty("deletions");
    expect(facts).not.toHaveProperty("changed_lines");
  });

  it("exposes the change facts as words and flags", () => {
    const facts = build().change_facts as JsonObject;
    expect(facts.languages).toEqual(["typescript", "markdown"]);
    expect(facts.areas).toEqual(["src/checkout"]);
    expect(facts.has_tests).toBe(true);
    expect(facts.tests_only).toBe(false);
    expect(facts.docs_only).toBe(false);
    expect(facts.touches_deps).toBe(false);
    expect(facts.touches_ci).toBe(false);
    expect(facts.touches_migration).toBe(false);
    expect(facts.touches_config).toBe(false);
    expect(facts.adds_files).toBe(true);
    expect(facts.removes_files).toBe(false);
    expect(facts.renames_files).toBe(false);
    expect(facts.file_count).toBe(3);
    expect(facts.files_truncated).toBe(false);
  });

  it("lists files with path, kind and status only (no per-file numbers for Jev to interpret)", () => {
    const facts = build().change_facts as JsonObject;
    expect(facts.files).toEqual([
      { path: "src/checkout/total.ts", kind: "source", status: "modified" },
      { path: "src/checkout/total.test.ts", kind: "test", status: "added" },
      { path: "README.md", kind: "docs", status: "modified" },
    ]);
  });

  it("maps the summary onto snake_case keys", () => {
    const summary = build().change_summary as JsonObject;
    expect(summary.what_changes).toBe(SUMMARY.whatChanges);
    expect(summary.behavior_changes).toEqual(SUMMARY.behaviorChanges);
    expect(summary.user_facing).toBe(true);
    expect(summary.breaking).toBe(false);
    expect(summary.areas).toEqual(["checkout"]);
    expect(summary.risks).toEqual(SUMMARY.risks);
  });

  it("omits change_summary entirely when the summary is null", () => {
    const state = build({ summary: null });
    expect(Object.keys(state)).toEqual(["intent", "change_facts"]);
    expect(state).not.toHaveProperty("change_summary");
  });

  it("is plain JSON: survives a stringify round trip unchanged", () => {
    const state = build();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
