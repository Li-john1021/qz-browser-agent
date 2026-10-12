/** Historical UI boundaries intentionally distinguish strings, coercion, and an absent selection. */
export function stringSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sessionIdText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function optionalSessionId(value: unknown): string | null {
  return sessionIdText(value) || null;
}
