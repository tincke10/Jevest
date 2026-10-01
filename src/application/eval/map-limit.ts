/**
 * Bounded worker pool: runs `fn` over `items` with at most `limit` calls in
 * flight and returns the results in INPUT order, whatever order they finish
 * in. `limit` 1 is strictly sequential. The first rejection rejects the
 * whole call (no new item starts after it).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("mapLimit: limit must be a positive integer");
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
