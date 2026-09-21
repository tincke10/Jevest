import { describe, expect, it } from "vitest";
import {
  type SpendCapConfig,
  type SpendLedger,
  applySpendEntry,
  evaluateSpendCap,
  spendPeriodKey,
} from "./spend-cap.js";

const NOW = new Date("2026-09-21T16:00:00Z");
const CAP: SpendCapConfig = { usd: 50, period: "month", warnAtUsd: 40 };

function ledger(overrides: Partial<SpendLedger> = {}): SpendLedger {
  return {
    periodKey: "2026-09",
    spentUsd: 0,
    runs: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("spendPeriodKey", () => {
  it("is the UTC calendar month for period month", () => {
    expect(spendPeriodKey("month", NOW)).toBe("2026-09");
    // 23:30 on Sep 30 in UTC-3 is already Oct 1 in UTC — the key is UTC, never local.
    expect(spendPeriodKey("month", new Date("2026-10-01T02:30:00Z"))).toBe("2026-10");
    expect(spendPeriodKey("month", new Date("2026-01-05T00:00:00Z"))).toBe("2026-01");
  });

  it('is the constant "total" for period total', () => {
    expect(spendPeriodKey("total", NOW)).toBe("total");
  });
});

describe("evaluateSpendCap", () => {
  it("treats a null ledger as zero spend with status ok", () => {
    const result = evaluateSpendCap({ ledger: null, cap: CAP, now: NOW, requestedBudgetUsd: 5 });
    expect(result).toEqual({
      status: "ok",
      period: "month",
      periodKey: "2026-09",
      spentUsd: 0,
      capUsd: 50,
      warnAtUsd: 40,
      remainingUsd: 50,
      effectiveBudgetUsd: 5,
    });
  });

  it("treats a ledger from a different period as zero (period rolled over)", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ periodKey: "2026-08", spentUsd: 49 }),
      cap: CAP,
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.status).toBe("ok");
    expect(result.spentUsd).toBe(0);
    expect(result.periodKey).toBe("2026-09");
  });

  it("reports warning once spend reaches warnAtUsd", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ spentUsd: 40 }),
      cap: CAP,
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.status).toBe("warning");
    expect(result.remainingUsd).toBe(10);
    expect(result.effectiveBudgetUsd).toBe(5);
  });

  it("reports reached once spend reaches usd, with zero effective budget", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ spentUsd: 50 }),
      cap: CAP,
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.status).toBe("reached");
    expect(result.remainingUsd).toBe(0);
    expect(result.effectiveBudgetUsd).toBe(0);
  });

  it("never reports negative remaining after an overshoot", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ spentUsd: 53 }),
      cap: CAP,
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.status).toBe("reached");
    expect(result.remainingUsd).toBe(0);
    expect(result.effectiveBudgetUsd).toBe(0);
  });

  it("clamps the per-run budget to what is left under the cap", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ spentUsd: 48 }),
      cap: CAP,
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.status).toBe("warning");
    expect(result.effectiveBudgetUsd).toBe(2);
  });

  it("uses the total period key when the cap never resets", () => {
    const result = evaluateSpendCap({
      ledger: ledger({ periodKey: "total", spentUsd: 10 }),
      cap: { usd: 50, period: "total", warnAtUsd: 40 },
      now: NOW,
      requestedBudgetUsd: 5,
    });
    expect(result.periodKey).toBe("total");
    expect(result.spentUsd).toBe(10);
  });
});

describe("applySpendEntry", () => {
  const entry = {
    periodKey: "2026-09",
    prNumber: 7,
    headSha: "abc",
    llmUsd: 1.5,
    jevUsd: 0.001,
    at: "2026-09-21T16:00:00.000Z",
  };

  it("starts a fresh ledger when none exists", () => {
    expect(applySpendEntry(null, entry)).toEqual({
      periodKey: "2026-09",
      spentUsd: 1.501,
      runs: 1,
      updatedAt: entry.at,
    });
  });

  it("adds to the ledger of the same period and increments runs", () => {
    expect(applySpendEntry(ledger({ spentUsd: 10, runs: 3 }), entry)).toEqual({
      periodKey: "2026-09",
      spentUsd: 11.501,
      runs: 4,
      updatedAt: entry.at,
    });
  });

  it("starts fresh when the stored period differs (rollover)", () => {
    expect(applySpendEntry(ledger({ periodKey: "2026-08", spentUsd: 49, runs: 9 }), entry)).toEqual(
      { periodKey: "2026-09", spentUsd: 1.501, runs: 1, updatedAt: entry.at },
    );
  });
});
