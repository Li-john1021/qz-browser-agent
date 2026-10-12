import { t } from "../../shared/i18n/backend.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";

type Fields = Record<string, unknown>;
import type { SessionGoal, SessionTracker, TrackerMode, TrackerStep } from "../../shared/contracts/session-runtime.js";
export type { SessionGoal, SessionTracker } from "../../shared/contracts/session-runtime.js";
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

export function normalizeGoalAction(action: unknown = "") {
  const value = String(action || "").trim();
  return ["create", "checkpoint", "update", "block", "complete", "pause", "resume", "clear", "get"].includes(value)
    ? value
    : "update";
}

export function buildNextSessionGoal(action: string, input: Fields = {}, previous: SessionGoal | null = null) {
  if (action === "get") return previous;
  if (action === "clear") return null;
  if (action === "complete" && !previous) {
    const err = Object.assign(new Error("manage_goal complete requires an active goal"), { code: "MISSING_GOAL", details: { action } });
    throw err;
  }
  if (action === "pause" && !previous) return null;
  if (action === "resume" && !previous) return null;

  const now = nowBeijingDateTime();
  const base = action === "create" || !previous
    ? createSessionGoal(input, now)
    : { ...previous };
  const patch = pickGoalPatch(input);
  const nextStatus = goalStatusForAction(action, base.status);
  return normalizeSessionGoal({
    ...base,
    ...patch,
    status: nextStatus,
    version: Math.max(0, Number(base.version) || 0) + 1,
    updatedAt: now,
    updatedByRunId: String(input.runId || base.updatedByRunId || "").slice(0, 120),
  });
}

function createSessionGoal(input: Fields = {}, now = nowBeijingDateTime()) {
  return {
    status: "active",
    objective: input.objective || "",
    criteria: input.criteria || "",
    progress: input.progress || "",
    next: input.next || "",
    checkpoint: input.checkpoint || "",
    version: 0,
    createdAt: now,
    updatedAt: now,
    updatedByRunId: String(input.runId || "").slice(0, 120),
  };
}

function goalStatusForAction(action: string, fallback: unknown = "active") {
  if (action === "block") return "blocked";
  if (action === "complete") return "complete";
  if (action === "pause") return "paused";
  if (action === "resume") return "active";
  if (action === "update" && fallback === "blocked") return "blocked";
  return normalizeGoalStatus(fallback);
}

function pickGoalPatch(input: Fields = {}) {
  const out: Fields = {};
  if (input.objective != null) out.objective = input.objective;
  if (input.criteria != null) out.criteria = input.criteria;
  if (input.progress != null) out.progress = input.progress;
  if (input.next != null) out.next = input.next;
  if (input.checkpoint != null) out.checkpoint = input.checkpoint;
  return out;
}

export function normalizeSessionGoal(value: unknown): SessionGoal | null {
  const goal = record(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = normalizeGoalStatus(goal.status);
  const objective = clipText(String(goal.objective || "").trim(), 240);
  const criteria = clipText(String(goal.criteria || "").trim(), 360);
  const progress = clipText(String(goal.progress || "").trim(), 360);
  const next = clipText(String(goal.next || "").trim(), 240);
  const checkpoint = clipText(String(goal.checkpoint || "").trim(), 500);
  if (!objective && !criteria && !progress && !next && !checkpoint && status !== "complete") return null;
  return {
    status,
    objective,
    criteria,
    progress,
    next,
    checkpoint,
    version: Math.max(0, Math.floor(Number(goal.version) || 0)),
    createdAt: String(goal.createdAt || goal.updatedAt || nowBeijingDateTime()),
    updatedAt: String(goal.updatedAt || nowBeijingDateTime()),
    updatedByRunId: String(goal.updatedByRunId || "").slice(0, 120),
  };
}

function normalizeGoalStatus(status: unknown = ""): SessionGoal["status"] {
  const value = String(status || "").trim();
  return value === "blocked" || value === "paused" || value === "complete" ? value : "active";
}

export function summarizeSessionGoal(goal: SessionGoal | null | undefined) {
  return goal
    ? {
        status: goal.status,
        objective: goal.objective,
        progress: goal.progress,
        next: goal.next,
        checkpoint: goal.checkpoint,
        version: goal.version,
      }
    : null;
}

export function normalizeTrackerAction(action: unknown = "") {
  const value = String(action || "").trim();
  return ["start", "update", "finish", "fail", "abort", "clear"].includes(value) ? value : "update";
}

export function buildNextSessionTracker(action: string, input: Fields = {}, previous: SessionTracker | null = null) {
  if (["finish", "fail", "abort", "clear"].includes(action)) return null;
  const base = action === "start" || !previous
    ? createSessionTracker(input)
    : { ...previous };
  return normalizeSessionTracker({
    ...base,
    ...pickTrackerPatch(input),
    id: base.id || createTrackerId(),
    status: "active",
    startedAt: base.startedAt || nowBeijingDateTime(),
    updatedAt: nowBeijingDateTime(),
  });
}

function createSessionTracker(input: Fields = {}): SessionTracker {
  const steps = normalizeTrackerSteps(input.steps);
  const mode = normalizeTrackerMode(input.mode, steps);
  const total = normalizeTrackerNumber(input.total, steps.length || 0);
  return {
    id: createTrackerId(),
    mode,
    title: clipText(String(input.title || trackerDefaultTitle(mode)), 80),
    status: "active",
    steps,
    total: total > 0 ? total : 0,
    current: 0,
    completed: 0,
    currentStep: steps.length ? 1 : 0,
    unit: normalizeTrackerUnit(input.unit, mode),
    note: "",
    stats: null,
    startedAt: nowBeijingDateTime(),
    updatedAt: nowBeijingDateTime(),
  };
}

function pickTrackerPatch(input: Fields = {}) {
  const out: Fields = {};
  if (input.mode != null) out.mode = normalizeTrackerMode(input.mode, normalizeTrackerSteps(input.steps));
  if (input.title != null) out.title = clipText(String(input.title || ""), 80);
  if (input.steps != null) out.steps = normalizeTrackerSteps(input.steps);
  if (input.total != null) out.total = normalizeTrackerNumber(input.total, 0);
  if (input.current != null) out.current = normalizeTrackerNumber(input.current, 0);
  if (input.completed != null) out.completed = normalizeTrackerNumber(input.completed, 0);
  if (input.currentStep != null) out.currentStep = normalizeTrackerNumber(input.currentStep, 0);
  if (input.unit != null) out.unit = normalizeTrackerUnit(input.unit, out.mode || "");
  if (input.note != null) out.note = clipText(String(input.note || ""), 180);
  if (input.stats != null) out.stats = normalizeTrackerStats(input.stats);
  return out;
}

export function normalizeSessionTracker(value: unknown): SessionTracker | null {
  const tracker = record(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const steps = normalizeTrackerSteps(tracker.steps);
  const mode = normalizeTrackerMode(tracker.mode, steps);
  const total = normalizeTrackerNumber(tracker.total, steps.length || 0);
  const current = normalizeTrackerNumber(tracker.current, 0);
  const completed = normalizeTrackerNumber(tracker.completed, current);
  const currentStep = normalizeTrackerNumber(tracker.currentStep, steps.length ? Math.min(steps.length, Math.max(1, completed + 1)) : 0);
  return {
    id: String(tracker.id || createTrackerId()).slice(0, 80),
    mode,
    title: clipText(String(tracker.title || trackerDefaultTitle(mode)), 80),
    status: tracker.status === "active" ? "active" : "active",
    steps: decorateTrackerSteps(steps, currentStep, completed),
    total,
    current: clampTrackerCount(current, total),
    completed: clampTrackerCount(completed, total),
    currentStep: steps.length ? Math.max(1, Math.min(steps.length, currentStep || 1)) : 0,
    unit: normalizeTrackerUnit(tracker.unit, mode),
    note: clipText(String(tracker.note || ""), 180),
    stats: normalizeTrackerStats(tracker.stats),
    startedAt: String(tracker.startedAt || nowBeijingDateTime()),
    updatedAt: String(tracker.updatedAt || nowBeijingDateTime()),
  };
}

function normalizeTrackerMode(mode: unknown, steps: readonly TrackerStep[] = []): TrackerMode {
  const value = String(mode || "").trim();
  if (value === "steps" || value === "pagination" || value === "generic") return value;
  return steps.length ? "steps" : "generic";
}

function normalizeTrackerSteps(steps: unknown): TrackerStep[] {
  const raw: unknown[] = Array.isArray(steps) ? steps : [];
  return raw
    .map((item, index) => {
      const label = typeof item === "string" ? item : record(item).label;
      const text = clipText(String(label || "").trim(), 80);
      if (!text) return null;
      return {
        id: String(record(item).id || `step_${index + 1}`).slice(0, 40),
        label: text,
      };
    })
    .filter((step): step is TrackerStep => step !== null)
    .slice(0, 50);
}

function decorateTrackerSteps(steps: readonly TrackerStep[], currentStep: number, completed: number): TrackerStep[] {
  return steps.map((step, index) => {
    const ordinal = index + 1;
    const status = ordinal <= completed
      ? "done"
      : ordinal === currentStep
        ? "active"
        : "pending";
    return { ...step, status };
  });
}

function normalizeTrackerNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(number));
}

function clampTrackerCount(value: unknown, total: number) {
  const count = normalizeTrackerNumber(value, 0);
  return total > 0 ? Math.min(total, count) : count;
}

function normalizeTrackerUnit(unit: unknown, mode: unknown = "") {
  const text = String(unit || "").trim();
  if (text) return clipText(text, 12);
  if (mode === "pagination") return t("progress.pages");
  if (mode === "steps") return t("progress.steps");
  return "";
}

function normalizeTrackerStats(stats: unknown): SessionTracker["stats"] {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
  const out: NonNullable<SessionTracker["stats"]> = {};
  for (const [key, value] of Object.entries(stats).slice(0, 12)) {
    const name = String(key || "").trim().slice(0, 40);
    if (!name) continue;
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[name] = typeof value === "string" ? clipText(value, 120) : value;
    } else {
      out[name] = clipText(JSON.stringify(value), 160);
    }
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeSessionTracker(tracker: SessionTracker | null | undefined) {
  return tracker
    ? {
        mode: tracker.mode,
        title: tracker.title,
        current: tracker.current,
        completed: tracker.completed,
        total: tracker.total,
        note: tracker.note,
      }
    : null;
}

function trackerDefaultTitle(mode = "") {
  if (mode === "pagination") return t("progress.pagination");
  if (mode === "steps") return t("progress.taskSteps");
  return t("progress.task");
}

function createTrackerId() {
  return `tracker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clipText(value: unknown, maxChars: number) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} chars omitted]`;
}

