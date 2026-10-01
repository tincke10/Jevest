/**
 * In-process mutual exclusion per key (a repo dir, a ledger file path), for
 * `pnpm eval:review --concurrency n`: cases that share a git repo or a JSON
 * ledger must not interleave their critical sections. Tasks on one key run
 * one at a time in call order; different keys never wait on each other.
 */
export interface KeyedMutex {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(task, task);
      const tail = result.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}

/** A git failure caused by another git process holding a lock file. */
export function isLockContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\.lock\b|could not lock|unable to lock/i.test(message);
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Retries `task` with linear-doubling backoff while it fails on lock contention. */
export async function retryOnLockContention<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || !isLockContention(error)) throw error;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
}
