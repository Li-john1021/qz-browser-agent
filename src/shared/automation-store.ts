import { getLocale } from "./i18n/index.js";
import { t } from "./i18n/backend.js";
export type Automation = NonNullable<ReturnType<typeof normalizeAutomation>>;
export type AutomationRun = NonNullable<ReturnType<typeof normalizeAutomationRun>>;
export type AutomationSchedule = ReturnType<typeof normalizeAutomationSchedule>;

import {
  formatBeijingDateTime,
  nowBeijingDateTime,
  parseBeijingDateTime,
} from "./time-utils.js";

export const AUTOMATIONS_KEY = "_automations";
export const AUTOMATION_RUNS_KEY = "_automation_runs";

export const AUTOMATION_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
});

export const AUTOMATION_RUN_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
  ABORTED: "aborted",
  INTERRUPTED: "interrupted",
  SKIPPED: "skipped",
});

export const AUTOMATION_MISSED_POLICY = Object.freeze({
  RUN_ONCE: "run_once",
  LATEST_ONLY: "latest_only",
  SKIP: "skip",
});

export const AUTOMATION_NOTIFY_POLICY = Object.freeze({
  FAILURE: "failure",
  ALWAYS: "always",
  SILENT: "silent",
});

const ACTIVE_RUN_STATUSES = new Set<string>([
  AUTOMATION_RUN_STATUS.PENDING,
  AUTOMATION_RUN_STATUS.RUNNING,
]);

const DEFAULT_SCHEDULE = Object.freeze({
  type: "daily",
  time: "09:00",
  weekday: 1,
  intervalHours: 1,
  intervalMinutes: 60,
});

export function genAutomationId() {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function genAutomationRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeAutomation(value: unknown = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = String(input.id || "").trim();
  if (!id) return null;
  const instruction = String(input.instruction || "").trim();
  const title = String(input.title || instruction || t("automation.defaultTitle")).trim().slice(0, 80);
  const schedule = normalizeAutomationSchedule(input.schedule);
  const enabled = input.enabled !== false;
  const runningRunId = String(input.runningRunId || "").trim();
  return {
    id,
    title,
    instruction,
    schedule,
    missedPolicy: normalizeMissedPolicy(input.missedPolicy, schedule.type),
    notifyPolicy: normalizeNotifyPolicy(input.notifyPolicy),
    enabled,
    status: runningRunId
      ? AUTOMATION_STATUS.RUNNING
      : enabled
        ? AUTOMATION_STATUS.IDLE
        : AUTOMATION_STATUS.PAUSED,
    nextRunAt: normalizeDateTime(input.nextRunAt),
    lastRunId: String(input.lastRunId || "").trim(),
    lastRunStatus: String(input.lastRunStatus || "").trim(),
    lastRunAt: normalizeDateTime(input.lastRunAt),
    runningRunId,
    runningSessionId: String(input.runningSessionId || "").trim(),
    sourceSessionId: String(input.sourceSessionId || "").trim(),
    createdAt: normalizeDateTime(input.createdAt) || nowBeijingDateTime(),
    updatedAt: normalizeDateTime(input.updatedAt) || nowBeijingDateTime(),
  };
}

export function normalizeAutomationRun(value: unknown = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = String(input.id || "").trim();
  const automationId = String(input.automationId || "").trim();
  if (!id || !automationId) return null;
  const status = normalizeRunStatus(input.status);
  return {
    id,
    automationId,
    sessionId: String(input.sessionId || "").trim(),
    status,
    triggerType: normalizeTriggerType(input.triggerType),
    plannedAt: normalizeDateTime(input.plannedAt),
    startedAt: normalizeDateTime(input.startedAt),
    endedAt: normalizeDateTime(input.endedAt),
    delayed: input.delayed === true,
    delayReason: String(input.delayReason || "").trim(),
    error: String(input.error || "").trim(),
    createdAt: normalizeDateTime(input.createdAt) || nowBeijingDateTime(),
    updatedAt: normalizeDateTime(input.updatedAt) || nowBeijingDateTime(),
  };
}

export function normalizeAutomationSchedule(input: unknown = {}) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const type = typeof raw.type === "string" && ["once", "hourly", "daily", "weekly"].includes(raw.type) ? raw.type : DEFAULT_SCHEDULE.type;
  const time = normalizeTime(raw.time || DEFAULT_SCHEDULE.time);
  const weekday = Math.max(1, Math.min(7, Math.floor(Number(raw.weekday) || DEFAULT_SCHEDULE.weekday)));
  const intervalMinutes = normalizeIntervalMinutes(raw);
  const intervalHours = Math.max(1, Math.min(24, Math.ceil(intervalMinutes / 60)));
  const runAt = normalizeOnceRunAt(raw, type, time);
  return { type, time, weekday, intervalHours, intervalMinutes, ...(runAt ? { runAt } : {}) };
}

export function computeNextRunAt(scheduleInput: unknown = {}, fromMs = Date.now()) {
  const schedule = normalizeAutomationSchedule(scheduleInput);
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  if (schedule.type === "once") return schedule.runAt || "";
  if (schedule.type === "hourly") return computeHourlyNextRunAt(schedule, from);
  if (schedule.type === "weekly") return computeWeeklyNextRunAt(schedule, from);
  return computeDailyNextRunAt(schedule, from);
}

export function describeAutomationSchedule(scheduleInput: unknown = {}) {
  const schedule = normalizeAutomationSchedule(scheduleInput);
  if (schedule.type === "once") {
    return t("automation.once", { time: String(String(schedule.runAt || "").slice(0, 16) || t("automation.timeUnset")) });
  }
  if (schedule.type === "hourly") {
    return describeIntervalSchedule(schedule.intervalMinutes);
  }
  if (schedule.type === "weekly") {
    return t("automation.weekly", { weekday: String(weekdayLabel(schedule.weekday)), time: String(schedule.time) });
  }
  return t("automation.daily", { time: String(schedule.time) });
}

export function isActiveAutomationRunStatus(status = "") {
  return ACTIVE_RUN_STATUSES.has(status);
}

function computeHourlyNextRunAt(schedule: AutomationSchedule, fromMs: number) {
  const parts = beijingPartsFromMs(fromMs + schedule.intervalMinutes * 60 * 1000);
  const ms = beijingEpochMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, 0);
  return formatBeijingDateTime(new Date(ms));
}

function normalizeIntervalMinutes(raw: Record<string, unknown> = {}) {
  const explicitMinutes = Number(raw.intervalMinutes);
  if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) {
    return clampIntervalMinutes(explicitMinutes);
  }
  const hours = Number(raw.intervalHours);
  if (Number.isFinite(hours) && hours > 0) {
    return clampIntervalMinutes(hours * 60);
  }
  return DEFAULT_SCHEDULE.intervalMinutes;
}

function clampIntervalMinutes(value: unknown) {
  const minutes = Math.round(Number(value) || DEFAULT_SCHEDULE.intervalMinutes);
  const allowed = [5, 15, 30, 60];
  return allowed.reduce((best, item) => (
    Math.abs(item - minutes) < Math.abs(best - minutes) ? item : best
  ), allowed[allowed.length - 1]);
}

function normalizeOnceRunAt(raw: Record<string, unknown> = {}, _type = "", time: string = DEFAULT_SCHEDULE.time) {
  const explicit = normalizeDateTimeLike(raw.runAt || raw.datetime || raw.dateTime);
  if (explicit) return explicit;

  const date = String(raw.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return normalizeDateTime(`${date} ${normalizeTime(time)}:00`);
  }

  return "";
}

function normalizeDateTimeLike(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";

  const exact = normalizeDateTime(text);
  if (exact) return exact;

  const zonedIso = text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (zonedIso) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? formatBeijingDateTime(new Date(ms)) : "";
  }

  const flexible = text.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:[\sT]*)?(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?$/);
  if (!flexible) return "";
  const [, year, month, day, hour, minute, second = "0"] = flexible;
  const normalized = [
    `${year}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`,
    `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}:${String(Number(second)).padStart(2, "0")}`,
  ].join(" ");
  return normalizeDateTime(normalized);
}

function describeIntervalSchedule(minutes: unknown) {
  const value = clampIntervalMinutes(minutes);
  if (value < 60) return t("automation.intervalMinutes", { minutes: String(value) });
  return t("automation.hourly");
}

function computeDailyNextRunAt(schedule: AutomationSchedule, fromMs: number) {
  const parts = beijingPartsFromMs(fromMs);
  const { hour, minute } = splitTime(schedule.time);
  let ms = beijingEpochMs(parts.year, parts.month, parts.day, hour, minute, 0);
  if (ms <= fromMs) ms += 24 * 60 * 60 * 1000;
  return formatBeijingDateTime(new Date(ms));
}

function computeWeeklyNextRunAt(schedule: AutomationSchedule, fromMs: number) {
  const parts = beijingPartsFromMs(fromMs);
  const { hour, minute } = splitTime(schedule.time);
  for (let offset = 0; offset <= 7; offset += 1) {
    const dayMs = beijingEpochMs(parts.year, parts.month, parts.day, 0, 0, 0) + offset * 24 * 60 * 60 * 1000;
    const dayParts = beijingPartsFromMs(dayMs);
    if (dayParts.weekday !== schedule.weekday) continue;
    const ms = beijingEpochMs(dayParts.year, dayParts.month, dayParts.day, hour, minute, 0);
    if (ms > fromMs) return formatBeijingDateTime(new Date(ms));
  }
  return formatBeijingDateTime(new Date(fromMs + 7 * 24 * 60 * 60 * 1000));
}

function normalizeDateTime(value: unknown) {
  const text = String(value || "").trim();
  return parseBeijingDateTime(text) ? text : "";
}

function normalizeTime(value: unknown) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_SCHEDULE.time;
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeMissedPolicy(value: unknown, scheduleType = "") {
  const policy = String(value || "").trim();
  if (includesValue(Object.values(AUTOMATION_MISSED_POLICY), policy)) return policy;
  return scheduleType === "hourly"
    ? AUTOMATION_MISSED_POLICY.LATEST_ONLY
    : AUTOMATION_MISSED_POLICY.RUN_ONCE;
}

function normalizeNotifyPolicy(value: unknown) {
  const policy = String(value || "").trim();
  return includesValue(Object.values(AUTOMATION_NOTIFY_POLICY), policy)
    ? policy
    : AUTOMATION_NOTIFY_POLICY.FAILURE;
}

function normalizeRunStatus(value: unknown) {
  const status = String(value || "").trim();
  return includesValue(Object.values(AUTOMATION_RUN_STATUS), status)
    ? status
    : AUTOMATION_RUN_STATUS.PENDING;
}

function normalizeTriggerType(value: unknown) {
  const type = String(value || "").trim();
  return ["schedule", "manual", "catchup"].includes(type) ? type : "schedule";
}

function includesValue<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function splitTime(time: string) {
  const normalized = normalizeTime(time);
  const [hour, minute] = normalized.split(":").map(Number);
  return { hour, minute };
}

function weekdayLabel(weekday: number) {
  const index = Math.max(1, Math.min(7, Number(weekday) || 1)) - 1;
  const locale = getLocale();
  // 2024-01-01 was a Monday; UTC keeps this display-only lookup independent of local time.
  return new Intl.DateTimeFormat(locale, { weekday: locale.startsWith("zh") ? "narrow" : "long", timeZone: "UTC" })
    .format(Date.UTC(2024, 0, 1 + index));
}

function beijingPartsFromMs(ms: number) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ms))
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayIndex(parts.weekday),
  };
}

function weekdayIndex(label = "") {
  const text = String(label || "").toLowerCase();
  if (text.startsWith("mon")) return 1;
  if (text.startsWith("tue")) return 2;
  if (text.startsWith("wed")) return 3;
  if (text.startsWith("thu")) return 4;
  if (text.startsWith("fri")) return 5;
  if (text.startsWith("sat")) return 6;
  return 7;
}

function beijingEpochMs(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}
