import { describe, expect, it } from "vitest";
import { mapLimit } from "./map-limit.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapLimit", () => {
  it("returns results in input order regardless of completion order", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const done: number[] = [];
    const run = mapLimit([0, 1, 2], 3, async (i) => {
      await gates[i]?.promise;
      done.push(i);
      return `r${i}`;
    });
    gates[2]?.resolve();
    gates[0]?.resolve();
    gates[1]?.resolve();
    expect(await run).toEqual(["r0", "r1", "r2"]);
    expect(done).toEqual([2, 0, 1]);
  });

  it("never runs more than the limit at once and starts the next as one finishes", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const started: number[] = [];
    const run = mapLimit([0, 1, 2, 3, 4], 2, async (i) => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await gates[i]?.promise;
      active--;
      return i;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);
    for (const g of gates) g.resolve();
    expect(await run).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("limit 1 is strictly sequential", async () => {
    const order: string[] = [];
    await mapLimit(["a", "b"], 1, async (x) => {
      order.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end ${x}`);
    });
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("handles empty input and a limit above the item count", async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
  });

  it("rejects an invalid limit and propagates the first error", async () => {
    await expect(mapLimit([1], 0, async (x) => x)).rejects.toThrow(/positive integer/);
    await expect(
      mapLimit([1, 2], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});
