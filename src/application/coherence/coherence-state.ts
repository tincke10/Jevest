/**
 * Builds the three-layer state Jev sees for the intent–change coherence
 * question (H7, SPEC §4.2):
 *
 * - `intent`: the author's own story (title, body, labels). Untrusted input
 *   per NFR-7, and the state says so in a note so Jev weighs it as a claim,
 *   not as a fact.
 * - `change_facts`: computed in code from paths and counts (change-facts.ts).
 *   Per NFR-5 the size reaches Jev only as a word; line totals are dropped
 *   here and the per-file numbers are not listed, since Jev recognizes text
 *   and must never be handed a number to interpret.
 * - `change_summary`: an LLM's reading of the diff that never saw the
 *   description (see change-summarizer-port.ts). Omitted entirely when the
 *   experiment arm runs without a summarizer, rather than sent as null.
 *
 * Keys are snake_case plain English, like every other state in this repo.
 */
import type { JsonObject } from "../../domain/json.js";
import type { ChangeSummary } from "../../domain/ports/change-summarizer-port.js";
import type { ChangeFacts } from "./change-facts.js";

export const MAX_BODY_CHARS = 1_500;

export interface CoherenceIntent {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface CoherenceStateInput {
  readonly intent: CoherenceIntent;
  readonly change: ChangeFacts;
  readonly summary: ChangeSummary | null;
}

const INTENT_NOTE =
  "written by the pull request author; may be inaccurate or describe a different change";
const CHANGE_FACTS_NOTE = "computed from file paths and line counts; no code was read";
const CHANGE_SUMMARY_NOTE =
  "written by an automated reader of the diff that did not see the description";

function intentSection(intent: CoherenceIntent): JsonObject {
  const truncated = intent.body.length > MAX_BODY_CHARS;
  return {
    note: INTENT_NOTE,
    title: intent.title,
    body: truncated ? intent.body.slice(0, MAX_BODY_CHARS) : intent.body,
    body_truncated: truncated,
    labels: [...intent.labels],
  };
}

function changeFactsSection(change: ChangeFacts): JsonObject {
  return {
    note: CHANGE_FACTS_NOTE,
    size: change.size,
    file_count: change.fileCount,
    languages: [...change.languages],
    areas: [...change.areas],
    has_tests: change.hasTests,
    tests_only: change.testsOnly,
    docs_only: change.docsOnly,
    touches_deps: change.touchesDeps,
    touches_ci: change.touchesCi,
    touches_migration: change.touchesMigration,
    touches_config: change.touchesConfig,
    adds_files: change.addsFiles,
    removes_files: change.removesFiles,
    renames_files: change.renamesFiles,
    files: change.files.map((f) => ({ path: f.path, kind: f.kind, status: f.status })),
    files_truncated: change.truncated,
  };
}

function changeSummarySection(summary: ChangeSummary): JsonObject {
  return {
    note: CHANGE_SUMMARY_NOTE,
    what_changes: summary.whatChanges,
    behavior_changes: [...summary.behaviorChanges],
    user_facing: summary.userFacing,
    breaking: summary.breaking,
    areas: [...summary.areas],
    risks: [...summary.risks],
  };
}

export function buildCoherenceState(input: CoherenceStateInput): JsonObject {
  const state: JsonObject = {
    intent: intentSection(input.intent),
    change_facts: changeFactsSection(input.change),
  };
  if (input.summary !== null) {
    state.change_summary = changeSummarySection(input.summary);
  }
  return state;
}
