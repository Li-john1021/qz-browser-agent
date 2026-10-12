export type StorageKeys = string | string[] | Record<string, unknown> | null;
export interface StorageAdapter {
  get(keys?: StorageKeys): Promise<Record<string, unknown>>;
  set(patch: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function requireStorage(storage: StorageAdapter | null | undefined): StorageAdapter {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function" || typeof storage.remove !== "function") {
    throw new TypeError("storage must expose async get, set, and remove methods");
  }
  return storage;
}

export function structuredCloneSafe<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
