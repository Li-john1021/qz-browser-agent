export const SESSION_RUNTIME_STATUS = Object.freeze({
  IDLE: "idle",
  PENDING: "pending",
  RUNNING: "running",
  WAITING_USER: "waiting_user",
  COMPLETED: "completed",
  ABORTED: "aborted",
  CANCELLED: "cancelled",
  ERROR: "error",
  INTERRUPTED: "interrupted",
});

const KNOWN_STATUSES = new Set<string>(Object.values(SESSION_RUNTIME_STATUS));
const ACTIVE_STATUSES = new Set<string>([
  SESSION_RUNTIME_STATUS.PENDING,
  SESSION_RUNTIME_STATUS.RUNNING,
  SESSION_RUNTIME_STATUS.WAITING_USER,
]);
const TERMINAL_STATUSES = new Set<string>([
  SESSION_RUNTIME_STATUS.COMPLETED,
  SESSION_RUNTIME_STATUS.ABORTED,
  SESSION_RUNTIME_STATUS.CANCELLED,
  SESSION_RUNTIME_STATUS.ERROR,
  SESSION_RUNTIME_STATUS.INTERRUPTED,
]);

export function normalizeSessionRuntimeStatus(value: unknown, fallback = "") {
  const status = normalizeAlias(value);
  if (KNOWN_STATUSES.has(status)) return status;
  const fallbackStatus = normalizeAlias(fallback);
  return KNOWN_STATUSES.has(fallbackStatus) ? fallbackStatus : "";
}

export function isActiveSessionRuntimeStatus(value: unknown) {
  return ACTIVE_STATUSES.has(normalizeSessionRuntimeStatus(value));
}

export function isTerminalSessionRuntimeStatus(value: unknown) {
  return TERMINAL_STATUSES.has(normalizeSessionRuntimeStatus(value));
}

export function isSettledSessionRuntimeStatus(value: unknown) {
  const status = normalizeSessionRuntimeStatus(value);
  return status === SESSION_RUNTIME_STATUS.IDLE || TERMINAL_STATUSES.has(status);
}

function normalizeAlias(value: unknown) {
  const status = String(value || "").trim().toLowerCase();
  return status === "canceled" ? SESSION_RUNTIME_STATUS.CANCELLED : status;
}
