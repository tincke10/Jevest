/**
 * The surface-profile question set (phase 0b, H0' — SPEC §4.2, FR-3.2).
 * Jev is never asked to judge whether a hunk has a defect (phase 0 showed
 * it can't); it's asked only about the hunk's recognizable surface: what
 * kind of change it is, and which concerns it touches.
 */
import type { ChoiceQuestion, NoulQuestion } from "../../../domain/question.js";
import type { QuestionSet } from "../questions.js";

export const PROFILE_CHANGE_KINDS = [
  "add-behavior",
  "modify-behavior",
  "delete",
  "rename-or-format",
] as const;

function changeKindQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Read the code hunk. Which kind of change is it? Judge only by what the hunk shows: the code before and after.",
    criteria: {
      "add-behavior":
        "The after version adds statements, branches, or calls that were not present before — new behavior.",
      "modify-behavior":
        "Statements that existed before are changed — a condition, value, or call is different — without adding or removing statements overall.",
      delete:
        "The after version has fewer statements or calls than before — code was removed, not replaced with new logic.",
      "rename-or-format":
        "The before and after are the same code: only names, whitespace, or comments differ. No statement, condition, or value actually changed.",
    },
  };
}

function touchesPublicApiQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk change the name, parameters, return type, or exported members of something declared with `export`? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk changes the signature or exported shape of an exported function, class, interface, type, or variable.",
      false:
        "The hunk does not touch any exported declaration's signature, or nothing exported appears in the hunk at all.",
    },
  };
}

function touchesErrorHandlingQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      'Does this hunk add or change a try, catch, finally, or throw, or call something whose name ends in "Error" (like a custom error class)? Judge only by what the hunk shows.',
    criteria: {
      true: "The hunk includes a try/catch/finally block, a throw statement, or constructs/calls something named like an Error type.",
      false: "The hunk has none of those: no try/catch/finally/throw, and no Error-named call.",
    },
  };
}

function touchesAsyncQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk use async/await, Promise, .then(, setTimeout, or queueMicrotask? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk uses at least one of: async/await, Promise, .then(, setTimeout, or queueMicrotask.",
      false: "The hunk uses none of those; it runs synchronously as far as the hunk shows.",
    },
  };
}

function touchesIoQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk reference file, network, or process I/O — things like fs, net, process, fetch, http, stream, Request, Response, readFile, or writeFile? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk references at least one of those I/O-related names.",
      false: "The hunk references none of those; it has no visible I/O surface.",
    },
  };
}

export const profileQuestionSet: QuestionSet = {
  name: "profile",
  questions: [
    { name: "change_kind", build: changeKindQuestion },
    { name: "touches_public_api", build: touchesPublicApiQuestion },
    { name: "touches_error_handling", build: touchesErrorHandlingQuestion },
    { name: "touches_async", build: touchesAsyncQuestion },
    { name: "touches_io", build: touchesIoQuestion },
  ],
};
