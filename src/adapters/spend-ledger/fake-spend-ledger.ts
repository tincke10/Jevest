/**
 * In-memory SpendLedgerPort for tests: starts from an optional seed ledger
 * and applies entries with the same domain arithmetic every real adapter
 * uses. `entries` is exposed so a test can assert what the pipeline
 * recorded (PR number, sha, llm/jev split) rather than only the total.
 */
import type { SpendLedgerPort } from "../../domain/ports/spend-ledger-port.js";
import { type SpendEntry, type SpendLedger, applySpendEntry } from "../../domain/spend-cap.js";

export interface FakeSpendLedger extends SpendLedgerPort {
  readonly entries: SpendEntry[];
  current(): SpendLedger | null;
}

export interface FakeSpendLedgerOptions {
  readonly seed?: SpendLedger | null;
  /** When set, `read()` rejects with this error (simulates an unreachable ledger). */
  readonly readError?: Error;
  /** When set, `record()` rejects with this error. */
  readonly recordError?: Error;
}

export function createFakeSpendLedger(options: FakeSpendLedgerOptions = {}): FakeSpendLedger {
  let ledger: SpendLedger | null = options.seed ?? null;
  const entries: SpendEntry[] = [];
  return {
    entries,
    current() {
      return ledger;
    },
    async read() {
      if (options.readError) {
        throw options.readError;
      }
      return ledger;
    },
    async record(entry) {
      if (options.recordError) {
        throw options.recordError;
      }
      entries.push(entry);
      ledger = applySpendEntry(ledger, entry);
      return ledger;
    },
  };
}
