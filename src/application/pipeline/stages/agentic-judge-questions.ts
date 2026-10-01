/**
 * Jev's staged judge for agentic findings (`reviewer.mode: agentic`): three
 * typed questions, asked one at a time per finding (separate requests, so
 * an earlier answer never anchors a later one, NFR-14), each with explicit
 * decision boundaries and an escape hatch. Structured the way Jev reads
 * best: instructions as `{ question, focus, ignore }`, options as
 * `{ what, examples, not_for }`. The mechanism vocabulary is adapted from
 * jev-review (correctness / security / reliability / compatibility /
 * test gap), with "regression" taking the compatibility list.
 *
 * State per question (built by agentic-judge.ts): `finding` (file, line,
 * category, claim, failingScenario) and `selectedEvidence` (each verified
 * evidence location re-read from the checkout, ±5 lines, redacted); the
 * severity step also gets the `mechanism` Jev picked.
 */
import type { AgenticCategory } from "../../../domain/agentic-finding.js";
import type { JsonObject } from "../../../domain/json.js";
import type { ChoiceQuestion, ScoreQuestion } from "../../../domain/question.js";

export function supportsQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions: {
      question: "Does selectedEvidence directly support finding.claim and finding.failingScenario?",
      inspect: ["selectedEvidence", "finding.claim", "finding.failingScenario"],
      focus:
        "Whether the code in selectedEvidence itself shows the mechanism the claim describes and makes the failing scenario reachable",
      ignore: [
        "How plausible the claim sounds without the code",
        "Style, naming or formatting",
        "Problems the claim does not describe",
        "Code that is not in selectedEvidence",
      ],
    },
    criteria: {
      proves: {
        what: "The code in selectedEvidence shows the problem the claim describes, and the failing scenario follows from it",
        examples: [
          "The claim says the loop skips the last item and the evidence shows `i < items.length - 1`",
          "The claim says a field is no longer sent and the evidence shows it removed from the payload builder",
        ],
        not_for:
          "Evidence that only shows the code exists or is related, without the faulty condition, value or call",
      },
      partially: {
        what: "The evidence shows part of the problem, but a step of the failing scenario depends on code or behavior selectedEvidence does not show",
        examples: [
          "The evidence shows a nullable value is read, but not whether any caller can pass null",
          "The evidence shows a changed return type, but not a consumer that relies on the old one",
        ],
      },
      noMatch: {
        what: "The evidence does not show the claimed problem: it shows different code, contradicts the claim, or the claim is speculative",
        examples: [
          "The evidence shows a guard that prevents the failing scenario",
          "The quoted code does not do what the claim says it does",
        ],
      },
    },
  };
}

type MechanismVocabulary = Readonly<Record<string, JsonObject | string>>;

/** Per category; `other` and `noIssue` always present (`noIssue` discards). */
export const AGENTIC_MECHANISMS: Readonly<Record<AgenticCategory, MechanismVocabulary>> = {
  correctness: {
    condition: {
      what: "A condition handles the wrong cases",
      examples: ["An inverted comparison", "An off-by-one bound", "A missing case in a switch"],
    },
    state: {
      what: "State is read, updated, or retained incorrectly",
      examples: ["A stale value is reused", "An update is applied to the wrong record"],
    },
    dataFlow: {
      what: "Data is transformed or passed incorrectly",
      examples: ["A value is written to the wrong field", "Units or formats are mixed up"],
    },
    asyncControl: {
      what: "Asynchronous ordering or error handling is incorrect",
      examples: ["A missing await", "A rejected promise is never handled"],
    },
    other: "Another concrete correctness mechanism shown by the evidence",
    noIssue: "The selected evidence does not support a concrete correctness issue",
  },
  security: {
    authorization: {
      what: "Authorization or trust boundaries are weakened",
      examples: ["An ownership check is removed", "A route skips the auth middleware"],
    },
    injection: {
      what: "Untrusted input can reach an unsafe interpreter or sink",
      examples: ["Request input concatenated into SQL", "User input passed to a shell command"],
    },
    exposure: {
      what: "Sensitive data can be disclosed",
      examples: ["A secret is logged", "A response now includes another user's data"],
    },
    unsafeDefault: {
      what: "A default configuration creates avoidable exposure",
      examples: ["Debug mode enabled by default", "CORS opened to any origin"],
    },
    other: "Another concrete security mechanism shown by the evidence",
    noIssue: "The selected evidence does not support a concrete security issue",
  },
  regression: {
    api: {
      what: "A public API or type contract changes incompatibly",
      examples: ["A required parameter is added", "A return type changes shape"],
    },
    behavior: {
      what: "Existing callers observe changed behavior",
      examples: ["A default value changes", "An error that used to be thrown is now swallowed"],
    },
    dataFormat: {
      what: "A persisted or exchanged format changes incompatibly",
      examples: ["A stored field is renamed without a migration", "An enum value changes meaning"],
    },
    protocol: {
      what: "An external command or protocol contract changes",
      examples: ["A webhook payload drops a field", "A CLI flag is removed"],
    },
    other: "Another concrete compatibility mechanism shown by the evidence",
    noIssue: "The selected evidence does not support a concrete regression or compatibility break",
  },
  reliability: {
    cleanup: {
      what: "A resource or side effect is not cleaned up",
      examples: ["A file handle is not closed on error", "A lock is never released"],
    },
    concurrency: {
      what: "Concurrency can race, deadlock, or lose work",
      examples: ["Two requests update shared state without a lock", "A check-then-act race"],
    },
    recovery: {
      what: "Failure or cancellation recovery is incomplete",
      examples: [
        "A partial write is left after a failure",
        "A retry repeats a non-idempotent call",
      ],
    },
    crash: {
      what: "A realistic path can throw or terminate unexpectedly",
      examples: ["Dereferencing a value that can be null", "An unhandled exception in a handler"],
    },
    other: "Another concrete reliability mechanism shown by the evidence",
    noIssue: "The selected evidence does not support a concrete reliability issue",
  },
  tests: {
    branch: {
      what: "An important new or changed branch lacks targeted coverage",
      examples: ["A new early return has no test", "A new status code path is untested"],
    },
    failure: {
      what: "A failure or cancellation path lacks coverage",
      examples: ["The error branch of a new call is never exercised"],
    },
    boundary: {
      what: "A boundary or edge case lacks coverage",
      examples: ["Empty input, zero, or the maximum size is never tested"],
    },
    integration: {
      what: "An interaction between components lacks coverage",
      examples: ["A changed contract between a service and its consumer has no test"],
    },
    other: "Another concrete test gap shown by the evidence",
    noIssue: "The selected evidence does not support a concrete test gap in risky changed logic",
  },
};

export function mechanismQuestion(category: AgenticCategory): ChoiceQuestion {
  return {
    type: "choice",
    instructions: {
      question:
        "Which mechanism best describes the problem finding.claim describes, as supported by selectedEvidence?",
      focus: "The concrete way the code in selectedEvidence produces the failing scenario",
      ignore: ["Style or naming", "Problems the claim does not describe"],
      fallback: "Select noIssue when selectedEvidence does not show a concrete issue",
    },
    criteria: { ...AGENTIC_MECHANISMS[category] },
  };
}

export const AGENTIC_SEVERITY_RUBRIC: readonly JsonObject[] = [
  {
    what: "No meaningful impact, or no supported issue",
    examples: ["A theoretical edge case no caller can reach"],
  },
  {
    what: "Minor or narrowly limited impact",
    examples: ["A wrong value in a rarely used admin report", "A misleading error message"],
  },
  {
    what: "Significant correctness, reliability, compatibility, or security impact",
    examples: ["Wrong totals for a common input", "An existing client breaks after deploy"],
  },
  {
    what: "Critical security, data-loss, or widespread outage impact",
    examples: ["Any user can read other users' data", "Every checkout request fails"],
  },
];

export function severityQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions: {
      question:
        "Assuming selectedEvidence exhibits finding.claim through the given mechanism, rate the likely production impact.",
      focus: "Who is affected, how often the failing scenario happens, and what goes wrong",
      ignore: ["How hard the fix is", "Style"],
    },
    criteria: AGENTIC_SEVERITY_RUBRIC,
  };
}
