export function normalizeRuntimeSessionId(sessionId: unknown, fallback = "default") {
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : fallback;
}

export function requireExplicitSessionId(sessionId: unknown, operation = "request") {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id) return id;
  const error = Object.assign(new Error(`${operation} requires sessionId`), { code: "MISSING_SESSION_ID", details: { operation } });
  throw error;
}

export function normalizeRuntimeStatus(status: unknown = "") {
  return String(status || "").trim().toLowerCase();
}

