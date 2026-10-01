import { describe, expect, it } from "vitest";
import { createKeyedMutex, isLockContention, retryOnLockContention } from "./keyed-mutex.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createKeyedMutex", () => {
  it("serializes the same key in call order", async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const task = (name: string) =>
      mutex.run("k", async () => {
        log.push(`start ${name}`);
        await tick();
        log.push(`end ${name}`);
        return name;
      });
    expect(await Promise.all([task("a"), task("b"), task("c")])).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("does not block different keys", async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const slow = mutex.run("a", async () => {
      log.push("a start");
      await tick();
      await tick();
      log.push("a end");
    });
    const fast = mutex.run("b", async () => {
      log.push("b");
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["a start", "b", "a end"]);
  });

  it("releases the lock when a task throws", async () => {
    const mutex = createKeyedMutex();
    await expect(
      mutex.run("k", async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(await mutex.run("k", async () => "ok")).toBe("ok");
  });
});

describe("retryOnLockContention", () => {
  it("recognizes git lock errors", () => {
    expect(
      isLockContention(new Error("fatal: Unable to create '/r/.git/index.lock': File exists.")),
    ).toBe(true);
    expect(isLockContention(new Error("could not lock config file .git/config: File exists"))).toBe(
      true,
    );
    expect(isLockContention(new Error("fatal: not a git repository"))).toBe(false);
  });

  it("retries contention errors with backoff, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryOnLockContention(
      async () => {
        if (++calls < 3) throw new Error("Unable to create 'x.lock': File exists");
        return "done";
      },
      { attempts: 5, baseDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("does not retry other errors and gives up after the attempts", async () => {
    let calls = 0;
    await expect(
      retryOnLockContention(
        async () => {
          calls++;
          throw new Error("fatal: bad object");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("bad object");
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryOnLockContention(
        async () => {
          calls++;
          throw new Error("index.lock exists");
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow("index.lock");
    expect(calls).toBe(3);
  });
});
