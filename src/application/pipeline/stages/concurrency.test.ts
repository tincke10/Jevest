import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("returns the results in input order even when later items finish first", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const finished: number[] = [];
    const results = await mapWithConcurrency(items, 4, async (item) => {
      await sleep((items.length - item) * 2);
      finished.push(item);
      return item * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(finished).not.toEqual(items);
  });

  it("never has more than `limit` items in flight, and reaches the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(2);
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });

  it("passes each item's index", async () => {
    const seen = await mapWithConcurrency(
      ["a", "b", "c"],
      2,
      async (item, index) => `${index}:${item}`,
    );
    expect(seen).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("on a rejection starts no new item, lets the in-flight ones settle, then throws the lowest-index error", async () => {
    const started: number[] = [];
    const settled: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      if (item === 1) {
        await sleep(5);
        settled.push(item);
        throw new Error("boom 1");
      }
      if (item === 0) {
        await sleep(1);
        settled.push(item);
        throw new Error("boom 0");
      }
      await sleep(1);
      settled.push(item);
      return item;
    });
    await expect(run).rejects.toThrow("boom 0");
    // Item 0 failed first; item 1 was already in flight and was awaited; nothing after started.
    expect(started).toEqual([0, 1]);
    expect(settled.sort()).toEqual([0, 1]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });
});
