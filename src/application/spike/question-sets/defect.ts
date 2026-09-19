/**
 * The defect question set (phase 0, H0 — SPEC §4.1). Kept as-is after the
 * pivot: H0 failed, but the runner and fixtures stay as evidence and
 * tooling (SPEC §5 "Fase 0 — CERRADA").
 */
import type { NoulQuestion, ScoreQuestion } from "../../../domain/question.js";
import type { QuestionSet } from "../questions.js";

/**
 * Score levels for `defect_likelihood`, indexed 0..3. Kept as a named
 * constant because the report's score normalization (score / (levels-1))
 * depends on this exact count.
 */
export const DEFECT_LIKELIHOOD_LEVELS = ["none", "unlikely", "likely", "certain"] as const;

function defectLikelihoodQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions:
      "Read the code hunk shown in `before`. Does it contain a defect: a bug that causes incorrect behavior, a crash, a security flaw, or a violation of the function's evident contract? Judge only the code shown in this hunk.",
    criteria: [
      "None: the hunk is correct as written. No plausible input or usage triggers incorrect behavior.",
      "Unlikely: the hunk looks correct in the common case, but a narrow edge case, such as an unusual input or a rare ordering, might trigger incorrect behavior.",
      "Likely: the hunk has a specific, describable flaw that a normal input plausibly triggers, even though it is not certain to always fail.",
      "Certain: the hunk is definitely wrong for its evident purpose. The incorrect behavior is directly visible in the code, not merely suspected.",
    ],
  };
}

function touchesPublicApiQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk change a function, method, class, or type that other files are meant to import and call? Judge only by what the hunk shows: exported symbols, signatures, or their documented behavior.",
    criteria: {
      true: "The hunk changes the signature, exported shape, or documented behavior of something other files import.",
      false:
        "The hunk only changes internal logic, local variables, private helpers, or test or comment code that nothing outside the file depends on.",
    },
  };
}

function touchesSecurityQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does this hunk touch authentication, authorization, cryptography, secrets, session handling, or sanitization of untrusted input? Judge only by what the hunk shows.",
    criteria: {
      true: "The hunk changes code that checks identity or permissions, encrypts, decrypts, or hashes data, handles credentials or tokens, or sanitizes untrusted input.",
      false:
        "The hunk changes unrelated logic, formatting, or business rules with no connection to any of those concerns.",
    },
  };
}

export const defectQuestionSet: QuestionSet = {
  name: "defect",
  questions: [
    { name: "defect_likelihood", build: defectLikelihoodQuestion },
    { name: "touches_public_api", build: touchesPublicApiQuestion },
    { name: "touches_security", build: touchesSecurityQuestion },
  ],
};
