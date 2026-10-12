/** Small capability-owned preferences; Session facts and credentials keep their existing stores. */
import type { ReadonlyJsonValue as JsonValue } from "./contracts/json.js";
export interface CapabilityStorageAdapter {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface CapabilityStorageOptions { readonly signal?: AbortSignal }
export interface CapabilityStateStore {
  get(key: string, options?: CapabilityStorageOptions): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue, options?: CapabilityStorageOptions): Promise<void>;
  remove(key: string, options?: CapabilityStorageOptions): Promise<void>;
}

const MAX_VALUE_BYTES = 64 * 1024;
const queues = new WeakMap<CapabilityStorageAdapter, Map<string, Promise<void>>>();
const validName = /^[a-z][a-z0-9_.-]{0,99}$/i;

/** Ownership is bound once. A shared queue keeps an old mount's write ahead of a new mount's read. */
export function createCapabilityStateStore(owner: string, storage: CapabilityStorageAdapter, signal: AbortSignal): CapabilityStateStore {
  if (!validName.test(owner)) throw new TypeError("Invalid capability storage owner");
  let owners = queues.get(storage);
  if (!owners) queues.set(storage, owners = new Map());
  const ownerQueues = owners;

  function run<T>(key: string, options: CapabilityStorageOptions | undefined, action: (key: string) => Promise<T>): Promise<T> {
    if (!validName.test(key)) return Promise.reject(new TypeError("Invalid capability storage key"));
    const lifetime = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
    const previous = ownerQueues.get(owner) || Promise.resolve();
    const operation = previous.then(async () => {
      lifetime.throwIfAborted();
      // Chrome writes already submitted cannot be undone; cancellation blocks queued work and late consumers.
      const result = await action(`qingzhou_capability:${owner}:${key}`);
      lifetime.throwIfAborted();
      return result;
    });
    const settled = operation.then(() => {}, () => {});
    ownerQueues.set(owner, settled);
    void settled.then(() => { if (ownerQueues.get(owner) === settled) ownerQueues.delete(owner); });
    return operation;
  }

  return Object.freeze({
    get(key: string, options?: CapabilityStorageOptions) {
      return run(key, options, async key => {
        const values = await storage.get(key);
        return values[key] === undefined ? undefined : copyJson(values[key]);
      });
    },
    async set(key: string, value: JsonValue, options?: CapabilityStorageOptions) {
      signal.throwIfAborted();
      options?.signal?.throwIfAborted();
      const snapshot = copyJson(value);
      await run(key, options, key => storage.set({ [key]: snapshot }));
    },
    remove(key: string, options?: CapabilityStorageOptions) {
      return run(key, options, key => storage.remove(key));
    },
  });
}

function copyJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function validate(value: unknown, depth: number): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || depth > 64 || ancestors.has(value)) throw new TypeError("Capability storage requires finite, acyclic JSON values");
    ancestors.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError("Capability storage requires plain JSON objects and arrays");
    const keys = Reflect.ownKeys(value).filter(key => !array || key !== "length");
    if (array && keys.length !== value.length) throw new TypeError("Capability storage requires dense JSON arrays");
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !property.enumerable || !("value" in property)
        || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new TypeError("Capability storage requires plain JSON properties");
      validate(property.value, depth + 1);
    }
    ancestors.delete(value);
  }
  validate(value, 0);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_VALUE_BYTES) throw new RangeError("Capability storage value exceeds 64 KiB");
  return JSON.parse(serialized) as JsonValue;
}
