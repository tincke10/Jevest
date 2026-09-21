/**
 * Port for the cumulative spend ledger behind the spend cap (SPEC NFR-10,
 * see ../spend-cap.ts). One running total per period; adapters decide
 * where it lives (a GitHub issue in the consumer repo, a JSON file for
 * local runs, memory for tests). Zero SDK imports: adapters implement it.
 *
 * Known race, accepted on purpose: two runs on different PRs can both
 * `read()` the same balance, both pass the cap check, and both `record()`.
 * The overshoot is bounded by one run's `budgetUsd` per concurrent run,
 * which is fine for a safety net whose job is "stop the bleeding by the
 * next run", not cent-exact accounting. A compare-and-swap over an issue
 * body would need an extra read per write and still not be atomic on
 * GitHub's side; not worth it for this.
 */
import type { SpendEntry, SpendLedger } from "../spend-cap.js";

export interface SpendLedgerPort {
  /** `null` when nothing has been recorded yet (first run ever). */
  read(): Promise<SpendLedger | null>;
  /**
   * Adds `entry` to the ledger for `entry.periodKey` — starting fresh when
   * the stored period differs — increments `runs`, persists, and returns
   * the new ledger. Adapters implement the arithmetic with
   * `applySpendEntry` from ../spend-cap.ts.
   */
  record(entry: SpendEntry): Promise<SpendLedger>;
}

export type { SpendEntry, SpendLedger };
