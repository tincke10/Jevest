/**
 * Wire format of a `SpendLedger`, shared by the GitHub-issue and
 * local-file adapters so both persist exactly the same JSON (snake_case
 * on the wire, camelCase in memory — same convention as the rest of the
 * adapters). Decoding is strict: a ledger that fails to parse throws
 * rather than reading as "nothing spent", because silently starting over
 * is precisely the failure a spend cap must not have.
 */
import { z } from "zod";
import type { SpendLedger } from "../../domain/spend-cap.js";

const wireSchema = z.object({
  period_key: z.string().min(1),
  spent_usd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
  updated_at: z.string().min(1),
});

export interface SpendLedgerWire {
  readonly period_key: string;
  readonly spent_usd: number;
  readonly runs: number;
  readonly updated_at: string;
}

export function encodeSpendLedger(ledger: SpendLedger): SpendLedgerWire {
  return {
    period_key: ledger.periodKey,
    spent_usd: ledger.spentUsd,
    runs: ledger.runs,
    updated_at: ledger.updatedAt,
  };
}

/** `source` names where the JSON came from, for the error message only. */
export function decodeSpendLedger(raw: string, source: string): SpendLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `jevest: spend ledger at ${source} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const result = wireSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `jevest: spend ledger at ${source} has an unexpected shape: ${result.error.message}`,
    );
  }
  return {
    periodKey: result.data.period_key,
    spentUsd: result.data.spent_usd,
    runs: result.data.runs,
    updatedAt: result.data.updated_at,
  };
}
