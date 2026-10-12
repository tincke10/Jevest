/**
 * Bounded concurrency for the stages that send one independent request
 * per item (hunk profile, Jev's staged judge, the verifier). Results come
 * back in INPUT order whatever order the requests finish in, so a stage's
 * output is the same as a one-at-a-time loop's.
 *
 * On a rejection no new item starts; the items already in flight are
 * awaited (no request is left running behind the caller's back, no
 * unhandled rejection), then the lowest-index rejection is thrown — the
 * one a sequential loop would have reached first among those that ran.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const failures: { index: number; error: unknown }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && failures.length === 0) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  const workers = Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw failures[0]?.error;
  }
  return results;
}
