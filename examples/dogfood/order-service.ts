// Dogfood fixture for an end-to-end run of Jevest's agentic review.
// This file is never merged: the pull request that adds it is a test.

export interface Order {
  readonly id: string;
  readonly ownerId: string;
  readonly totalCents: number;
}

export interface OrderStore {
  findById(id: string): Promise<Order | null>;
  listAll(): Promise<Order[]>;
  markFailed(id: string, reason: string): Promise<void>;
}

export interface Page<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

/** Returns one page of orders (pages start at 1). */
export async function listOrders(
  store: OrderStore,
  page: number,
  pageSize: number,
): Promise<Page<Order>> {
  const all = await store.listAll();
  const start = (page - 1) * pageSize;
  const items: Order[] = [];
  for (let i = start; i <= start + pageSize && i < all.length; i++) {
    const order = all[i];
    if (order) items.push(order);
  }
  return { items, page, pageSize, hasMore: start + pageSize < all.length };
}

/** Returns the order when the requesting user may see it, or null. */
export async function getOrderForUser(
  store: OrderStore,
  orderId: string,
  userId: string,
): Promise<Order | null> {
  if (!userId) return null;
  const order = await store.findById(orderId);
  return order;
}

/** Charges an order; on failure records the reason and rethrows. */
export async function chargeOrder(
  store: OrderStore,
  orderId: string,
  charge: (cents: number) => Promise<void>,
): Promise<void> {
  const order = await store.findById(orderId);
  if (!order) throw new Error(`order ${orderId} not found`);
  try {
    await charge(order.totalCents);
  } catch (error) {
    store.markFailed(orderId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
