interface SessionOrderRecord { id?: unknown; parentSessionId?: unknown; updatedAt?: unknown; createdAt?: unknown }
type Orders = Map<string, string[]>;
interface OrderOptions<T> { rootId?: string; compare?(a: T, b: T): number }
interface StableOrderOptions<T> extends OrderOptions<T> {
  records?: T[]; previousOrders?: Orders; now?: number; holdUntil?: number; lastAppliedAt?: number; throttleMs?: number;
}

import { parseBeijingDateTime } from "#sdk/shared/format";

export function compareSessionRecords(a: SessionOrderRecord = {}, b: SessionOrderRecord = {}) {
  const timeDiff = sessionTime(b) - sessionTime(a);
  if (timeDiff) return timeDiff;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

export function createSiblingOrders<T extends SessionOrderRecord>(records: T[] = [], options: OrderOptions<T> = {}) {
  const rootId = String(options.rootId || "0");
  const groups = new Map<string, T[]>();
  const ids = new Set(records.map(record => normalizeId(record?.id)).filter(Boolean));
  for (const record of records) {
    const id = normalizeId(record?.id);
    if (!id) continue;
    let parentId = normalizeId(record?.parentSessionId) || rootId;
    if (parentId === id || (parentId !== rootId && !ids.has(parentId))) parentId = rootId;
    const group = groups.get(parentId) || [];
    group.push(record);
    groups.set(parentId, group);
  }
  const orders: Orders = new Map();
  for (const [parentId, children] of groups.entries()) {
    orders.set(parentId, children.sort(options.compare || compareSessionRecords).map(item => normalizeId(item.id)));
  }
  return orders;
}

export function resolveStableSiblingOrders<T extends SessionOrderRecord>({
  records = [],
  previousOrders = new Map(),
  now = Date.now(),
  holdUntil = 0,
  lastAppliedAt = 0,
  throttleMs = 1200,
  rootId = "0",
  compare = compareSessionRecords,
}: StableOrderOptions<T> = {}) {
  const desiredOrders = createSiblingOrders(records, { rootId, compare });
  if (!previousOrders.size) {
    return { orders: desiredOrders, deferredUntil: 0, appliedAt: now, changed: true };
  }
  const changed = ordersDiffer(desiredOrders, previousOrders);
  if (!changed) return { orders: previousOrders, deferredUntil: 0, appliedAt: lastAppliedAt, changed: false };

  const membershipChanged = siblingMembershipChanged(desiredOrders, previousOrders);
  const holdRemaining = Math.max(0, Number(holdUntil) - now);
  const throttleRemaining = membershipChanged ? 0 : Math.max(0, throttleMs - (now - Number(lastAppliedAt || 0)));
  const deferMs = Math.max(holdRemaining, throttleRemaining);
  if (deferMs > 0) {
    return {
      orders: stableOrders(desiredOrders, previousOrders),
      deferredUntil: now + deferMs,
      appliedAt: lastAppliedAt,
      changed: true,
    };
  }
  return { orders: desiredOrders, deferredUntil: 0, appliedAt: now, changed: true };
}

export function rankBySessionId(orders: Orders = new Map()) {
  const ranks = new Map<string, number>();
  for (const ids of orders.values()) ids.forEach((id, index) => ranks.set(id, index));
  return ranks;
}

function stableOrders(desired: Orders, previous: Orders) {
  const out: Orders = new Map();
  for (const [parentId, desiredIds] of desired.entries()) {
    const desiredSet = new Set(desiredIds);
    const kept = (previous.get(parentId) || []).filter(id => desiredSet.has(id));
    const keptSet = new Set(kept);
    out.set(parentId, [...kept, ...desiredIds.filter(id => !keptSet.has(id))]);
  }
  return out;
}

function ordersDiffer(a: Orders, b: Orders) {
  if (a.size !== b.size) return true;
  for (const [parentId, ids] of a.entries()) {
    const previous = b.get(parentId) || [];
    if (ids.length !== previous.length || ids.some((id, index) => id !== previous[index])) return true;
  }
  return false;
}

function siblingMembershipChanged(a: Orders, b: Orders) {
  const nextParents = parentMap(a);
  const previousParents = parentMap(b);
  if (nextParents.size !== previousParents.size) return true;
  for (const [id, parent] of nextParents.entries()) if (previousParents.get(id) !== parent) return true;
  return false;
}

function parentMap(orders: Orders) {
  const out = new Map<string, string>();
  for (const [parent, ids] of orders.entries()) for (const id of ids) out.set(id, parent);
  return out;
}

function sessionTime(record: SessionOrderRecord) {
  return parseBeijingDateTime(record?.updatedAt || record?.createdAt || "") || 0;
}

function normalizeId(value: unknown) {
  return value == null ? "" : String(value).trim();
}
