/**
 * Shared test input for the narrator adapters' unit tests: one kept
 * finding, one needs-human finding and the hunk they sit in.
 */
import type { ReviewNarrativeInput } from "../../domain/ports/review-narrator-port.js";

export const SAMPLE_NARRATIVE_INPUT: ReviewNarrativeInput = {
  prId: "acme/shop#42",
  title: "Apply tax to the checkout total",
  description: "Checkout totals now include the regional tax rate.",
  changedFiles: ["src/checkout/total.ts"],
  hunks: [
    {
      file: "src/checkout/total.ts",
      hunkHeader: "@@ -10,3 +10,4 @@",
      diff: "@@ -10,3 +10,4 @@\n-const tax = 0;\n+const tax = subtotal * rate;\n+return Math.round(tax);",
    },
  ],
  findings: [
    {
      file: "src/checkout/total.ts",
      line: 12,
      lineEnd: 12,
      claim: "Rounding the tax to whole units drops cents",
      rationale: "Math.round on a currency amount in units loses the fractional part.",
      severity: "major",
      needsHuman: false,
    },
    {
      file: "src/checkout/total.ts",
      line: 11,
      lineEnd: 11,
      claim: "rate may be undefined for regions without tax",
      rationale: "subtotal * undefined is NaN.",
      severity: "minor",
      needsHuman: true,
    },
  ],
  language: "es",
  verdict: "needs-changes",
};

export const SAMPLE_REVIEW_MARKDOWN =
  "Buen cambio, pero el redondeo pierde centavos.\n\n- `src/checkout/total.ts:12`: ...\n\n**Veredicto: necesita cambios.**";
