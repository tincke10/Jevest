/**
 * The intent–change coherence question set (H7, SPEC §4.2). Jev is shown the
 * three-layer state from coherence-state.ts and asked only what it can
 * recognize by reading text side by side: does the author's description
 * talk about the same thing the facts and the summary show, and what kind of
 * change is it. No counting, no code reading, no numbers in any question
 * (NFR-5); one pull request per request (NFR-14).
 */
import type { ChoiceQuestion, NoulQuestion } from "../../domain/question.js";
import type { QuestionSet } from "../spike/questions.js";

export const RISK_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

function matchesIntentQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Compare the author's description of the pull request with the change facts and the change summary. Does the description describe THIS change?",
    criteria: {
      true: "The description talks about the same files, features or behavior that the change facts and summary show.",
      false:
        "The description talks about a different feature, file area or behavior than what actually changed.",
    },
  };
}

function userFacingQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Judging from the change facts and the change summary, could an end user or an API consumer observe a difference after this change?",
    criteria: {
      true: "The change alters something a user or API consumer would see, receive or be able to do: screens, responses, defaults, errors, formats.",
      false:
        "The change is internal only: tests, tooling, refactors, documentation, build or CI, with no observable difference for users or API consumers.",
    },
  };
}

function breakingQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Judging from the change facts and the change summary, must existing callers, integrations or users change something to keep working after this change?",
    criteria: {
      true: "A public API, configuration key, data format, default or contract that others depend on was removed, renamed or changed in a way that requires them to adapt.",
      false:
        "Existing callers and users keep working without changes: additions, internal work, or backwards-compatible changes only.",
    },
  };
}

function needsProductOwnerQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Judging from the description, the change facts and the change summary, does this change need sign-off from a product owner or another non-engineer before merging?",
    criteria: {
      true: "The change alters user-visible behavior, pricing, permissions, data retention, legal or compliance wording, or anything else a non-engineer would need to sign off on.",
      false:
        "The change is purely technical: internal refactor, tests, tooling, dependencies, documentation for developers, or a bug fix that restores the intended behavior.",
    },
  };
}

function riskLevelQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Judging from the description, the change facts and the change summary, how risky is merging this change? Consider the size word, the kinds of files touched, the summary's risks and whether it is breaking.",
    criteria: {
      none: "Nothing can go wrong for users or operators: documentation, comments, formatting, or tests only.",
      low: "Small, contained, well-tested change with no user-facing or breaking impact.",
      medium:
        "User-facing or moderately sized change, or one touching configuration, dependencies or CI, with tests present and no breaking impact.",
      high: "Breaking change, migration, or large change across several areas, or a user-facing change with no tests.",
      critical:
        "Touches authentication, permissions, payments, data deletion or retention, or a migration, and is large, breaking or untested.",
    },
  };
}

export const coherenceQuestionSet: QuestionSet = {
  name: "coherence",
  questions: [
    { name: "matches_intent", build: matchesIntentQuestion },
    { name: "user_facing", build: userFacingQuestion },
    { name: "breaking", build: breakingQuestion },
    { name: "needs_product_owner", build: needsProductOwnerQuestion },
    { name: "risk_level", build: riskLevelQuestion },
  ],
};
