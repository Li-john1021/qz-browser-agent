import type { ToolMetadata } from "./tools/tool-metadata-contract.js";

export interface CapabilityMetadata {
  readonly tools?: Readonly<Record<string, ToolMetadata>>;
  readonly actionLabels?: Readonly<Record<string, string>>;
  readonly families?: Readonly<Record<string, Readonly<{ id: string; title: string; shortTitle: string }>>>;
  readonly documentFormats?: readonly { readonly id: string; readonly mimeType: string; readonly output?: boolean }[];
}

/** Registrations never silently shadow another package's identity. */
export function mergeCapabilityRecords<T>(records: readonly (Readonly<Record<string, T>> | undefined)[]): Readonly<Record<string, T>> {
  const merged: Record<string, T> = Object.create(null);
  for (const entries of records) for (const [id, value] of Object.entries(entries || {})) {
    if (!id.trim() || Object.hasOwn(merged, id)) throw new Error(`Duplicate or empty capability identity: ${id}`);
    merged[id] = value;
  }
  return Object.freeze(merged);
}

/** Capture declaration getters as immutable plain data while preserving executable handlers. */
export function materializeContribution<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => materializeContribution(item))) as T;
  if (value && typeof value === "object") {
    const snapshot = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeContribution(item)]));
    if (Object.getPrototypeOf(value) === null) Object.setPrototypeOf(snapshot, null);
    return Object.freeze(snapshot) as T;
  }
  return value;
}
