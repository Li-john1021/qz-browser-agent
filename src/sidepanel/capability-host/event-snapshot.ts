import type { PortMessage } from "../features/app/port-client.js";

/** Events carry plain data. One detached, immutable snapshot serves every observer. */
export function createUiEventSnapshot(event: PortMessage): PortMessage {
  const snapshot = structuredClone(event);
  const visited = new WeakSet<object>();
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("UI events require plain objects and arrays");
    }
    visited.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(snapshot);
  return snapshot;
}
