import { t } from "../shared/i18n/backend.js";
interface TraceDebug {
  enabled?: boolean; console?: boolean; storage?: boolean; logs: string[];
  clear?(): number; dump?(filter?: string): string; last?(count?: number, filter?: string): string;
}
const traceGlobal = globalThis as typeof globalThis & { __qzDebug?: TraceDebug };
import { nowBeijingDateTime } from "../shared/time-utils.js";
import { stringifyJsonSafe } from "../shared/unicode-utils.js";

// Trace defaults to memory-off. Console/storage tracing is intentionally opt-in
// because high-volume stream logs can noticeably slow the extension UI.
const TRACE_KEY = "_llm_trace";
const TRACE_MAX = 1000;
const TRACE_MEMORY_MAX = 1000;
const TRACE_DEBUG_GLOBAL_KEY = "__qzDebug";
const TRACE_ENABLED = false;
const TRACE_CONSOLE_ENABLED = false;
const TRACE_STORAGE_ENABLED = false;

export function trace(msg: unknown) {
  recordTrace(msg, { enabled: isTraceEnabled(), consoleLabel: "LLM" });
}

export function setTraceDebugMode(enabled: unknown) {
  const debug = ensureTraceDebugGlobal();
  debug.enabled = enabled === true;
  return debug.enabled;
}

// Low-volume product diagnostics are always retained in the bounded memory
// buffer so a user can export them after a failure without enabling the much
// noisier LLM/stream trace beforehand.
export function diagnosticTrace(msg: unknown) {
  recordTrace(msg, { enabled: true, consoleLabel: t("trace.title") });
}

function recordTrace(msg: unknown, { enabled = false, consoleLabel = "LLM" } = {}) {
  if (!enabled) return;
  const line = `${nowBeijingDateTime()} ${msg}`;
  appendInMemoryTrace(line);
  if (isTraceConsoleEnabled()) console.log(`[${consoleLabel}] ${line}`);
  if (!isTraceStorageEnabled()) return;
  globalThis.chrome?.storage?.local?.get(TRACE_KEY).then(({ [TRACE_KEY]: stored }) => {
    let logs = Array.isArray(stored) ? stored.filter((line): line is string => typeof line === "string") : [];
    logs.push(line);
    if (logs.length > TRACE_MAX) logs = logs.slice(-TRACE_MAX);
    chrome.storage.local.set({ [TRACE_KEY]: logs });
  }).catch(() => {});
}

export function formatTraceFields(fields: Record<string, unknown> = {}) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}=${formatTraceValue(value)}`)
    .join("");
}

export function shouldTraceStreamDelta(count: unknown, gapMs = 0) {
  const n = Number(count) || 0;
  return n <= 3 || n % 20 === 0 || Number(gapMs) >= 500;
}

export async function getTraceLog() {
  const debug = getTraceDebugGlobal();
  const memoryLogs = Array.isArray(debug?.logs) ? debug.logs.slice() : [];
  if (!isTraceStorageEnabled()) return memoryLogs;
  const { [TRACE_KEY]: logs = [] } = await chrome.storage.local.get(TRACE_KEY);
  return Array.isArray(logs) ? logs : [];
}

export async function clearTraceLog() {
  getTraceDebugGlobal()?.clear?.();
  if (isTraceStorageEnabled()) await chrome.storage.local.remove(TRACE_KEY);
}

function getTraceDebugGlobal() {
  const debug = traceGlobal[TRACE_DEBUG_GLOBAL_KEY];
  return debug && typeof debug === "object" ? debug : null;
}

function isTraceEnabled() {
  return TRACE_ENABLED || getTraceDebugGlobal()?.enabled === true;
}

function isTraceConsoleEnabled() {
  return TRACE_CONSOLE_ENABLED || getTraceDebugGlobal()?.console === true;
}

function isTraceStorageEnabled() {
  return TRACE_STORAGE_ENABLED || getTraceDebugGlobal()?.storage === true;
}

function appendInMemoryTrace(line: string) {
  const debug = ensureTraceDebugGlobal();
  debug.logs.push(line);
  if (debug.logs.length > TRACE_MEMORY_MAX) {
    debug.logs.splice(0, debug.logs.length - TRACE_MEMORY_MAX);
  }
}

function ensureTraceDebugGlobal() {
  const existing = traceGlobal[TRACE_DEBUG_GLOBAL_KEY];
  if (existing && Array.isArray(existing.logs)) return existing;
  const debug: TraceDebug & Required<Pick<TraceDebug, "clear" | "dump" | "last">> = {
    logs: [],
    clear() {
      this.logs.length = 0;
      return 0;
    },
    dump(filter = "") {
      const needle = String(filter || "");
      const rows = needle ? this.logs.filter(line => line.includes(needle)) : this.logs;
      return rows.join("\n");
    },
    last(count = 120, filter = "") {
      const needle = String(filter || "");
      const rows = needle ? this.logs.filter(line => line.includes(needle)) : this.logs;
      return rows.slice(-Math.max(1, Number(count) || 120)).join("\n");
    },
  };
  try {
    Object.defineProperty(globalThis, TRACE_DEBUG_GLOBAL_KEY, {
      value: debug,
      configurable: true,
      writable: true,
    });
  } catch (_err) {
    traceGlobal[TRACE_DEBUG_GLOBAL_KEY] = debug;
  }
  return debug;
}

function formatTraceValue(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : stringifyJsonSafe(value);
  return String(text || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w:./|@=-]/g, "_")
    .slice(0, 160);
}
