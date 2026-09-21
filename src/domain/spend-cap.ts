/**
 * Cumulative spend cap (SPEC NFR-10, second half): `budgetUsd` caps ONE
 * run, this caps the WHOLE service over a period. It exists because the
 * reviewer may be billed to one person's Claude subscription (the
 * `claude-cli` provider reports a nominal list-price cost per review): a
 * busy repo could otherwise drain that quota without anyone noticing.
 * Pure arithmetic over a `SpendLedger` — reading/writing the ledger is a
 * port concern (see ports/spend-ledger-port.ts), so this file has no IO
 * and no SDK imports.
 *
 * Period keys are computed in UTC on purpose: the ledger is shared by
 * every runner and every human looking at it, and a calendar month that
 * depended on whichever timezone the runner happened to have would roll
 * over at different moments for different runs.
 */

export type SpendPeriod = "month" | "total";

export interface SpendCapConfig {
  /** Hard stop: once cumulative spend reaches this, the LLM review stage is skipped. */
  readonly usd: number;
  /** "month" = calendar month in UTC, resets automatically; "total" = never resets. */
  readonly period: SpendPeriod;
  /** Below `usd`; from here on every run carries a warning. */
  readonly warnAtUsd: number;
}

/** What the ledger port stores: one running total per period. */
export interface SpendLedger {
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly runs: number;
  /** ISO-8601 timestamp of the last `record`. */
  readonly updatedAt: string;
}

/** One pipeline run's contribution to the ledger. */
export interface SpendEntry {
  readonly periodKey: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly llmUsd: number;
  readonly jevUsd: number;
  /** ISO-8601 timestamp of the run. */
  readonly at: string;
}

export type SpendCapStatus = "ok" | "warning" | "reached";

export interface SpendCapEvaluation {
  readonly status: SpendCapStatus;
  readonly period: SpendPeriod;
  readonly periodKey: string;
  /** Spend counted against the cap in the current period (0 when the ledger belongs to a past period). */
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly warnAtUsd: number;
  /** Never negative, even after a concurrent-run overshoot. */
  readonly remainingUsd: number;
  /** `max(0, min(requestedBudgetUsd, remainingUsd))`: the per-run budget the review stage should actually get. */
  readonly effectiveBudgetUsd: number;
}

export function spendPeriodKey(period: SpendPeriod, now: Date): string {
  if (period === "total") {
    return "total";
  }
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export interface EvaluateSpendCapInput {
  readonly ledger: SpendLedger | null;
  readonly cap: SpendCapConfig;
  readonly now: Date;
  /** `.jevest.yml`'s `budgetUsd` for this run. */
  readonly requestedBudgetUsd: number;
}

/**
 * A ledger whose `periodKey` differs from the current one counts as zero:
 * the period rolled over and the next `record` will start a fresh total.
 */
export function evaluateSpendCap(input: EvaluateSpendCapInput): SpendCapEvaluation {
  const periodKey = spendPeriodKey(input.cap.period, input.now);
  const spentUsd =
    input.ledger !== null && input.ledger.periodKey === periodKey ? input.ledger.spentUsd : 0;
  const remainingUsd = Math.max(0, input.cap.usd - spentUsd);
  const effectiveBudgetUsd = Math.max(0, Math.min(input.requestedBudgetUsd, remainingUsd));

  let status: SpendCapStatus = "ok";
  if (spentUsd >= input.cap.usd) {
    status = "reached";
  } else if (spentUsd >= input.cap.warnAtUsd) {
    status = "warning";
  }

  return {
    status,
    period: input.cap.period,
    periodKey,
    spentUsd,
    capUsd: input.cap.usd,
    warnAtUsd: input.cap.warnAtUsd,
    remainingUsd,
    effectiveBudgetUsd,
  };
}

/**
 * The one arithmetic every ledger adapter shares: add the entry to the
 * stored total when the period matches, start over when it doesn't (or
 * when nothing is stored yet). Kept here so the GitHub-issue, local-file
 * and in-memory adapters cannot drift on what "record" means.
 */
export function applySpendEntry(current: SpendLedger | null, entry: SpendEntry): SpendLedger {
  const samePeriod = current !== null && current.periodKey === entry.periodKey;
  const base = samePeriod ? current : { spentUsd: 0, runs: 0 };
  return {
    periodKey: entry.periodKey,
    spentUsd: base.spentUsd + entry.llmUsd + entry.jevUsd,
    runs: base.runs + 1,
    updatedAt: entry.at,
  };
}
