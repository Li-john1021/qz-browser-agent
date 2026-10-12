import { t } from "../../shared/i18n/backend.js";
import { normalizeParentSessionId, ROOT_SESSION_ID } from "../../shared/session/session-store.js";

import type { TranscriptEntry } from "../../shared/contracts/session.js";
type Fields = Record<string, unknown>;
interface ChromeNotificationOptions {
  notifications?: Pick<typeof chrome.notifications, "create" | "clear" | "getPermissionLevel">;
  runtime?: Pick<typeof chrome.runtime, "lastError">;
  windows?: Pick<typeof chrome.windows, "getLastFocused" | "getAll" | "get" | "onFocusChanged" | "onRemoved">;
}
type OpenResult = boolean | { opened?: boolean };
interface CompletionNotifierOptions {
  notifications: ReturnType<typeof createChromeNotificationService>;
  iconUrl?: string; normalizeSessionId?(value: unknown): string;
  getRuntime?(sessionId: string): Fields; getRuntimeCheckpoint?(sessionId: string): Fields | null;
  getSessions?(): Promise<Record<string, Fields>>;
  getTranscript?(sessionId: string): Promise<TranscriptEntry[]>;
  getLastToolName?(transcript: TranscriptEntry[]): string;
  setRuntime?(sessionId: string, patch: Fields): unknown;
  activateWorkingTab?(sessionId: string, options: { focusWindow: boolean }): Promise<unknown>;
  openSession?(sessionId: string, options: { notificationId: string }): OpenResult | Promise<OpenResult>;
  getAutomationRuntime?(): { consumeNotificationSession?(notificationId: string): string } | null;
  now?(): string;
}

export function createChromeNotificationService({
  notifications = globalThis.chrome?.notifications,
  runtime = globalThis.chrome?.runtime,
  windows = globalThis.chrome?.windows,
}: ChromeNotificationOptions = {}) {
  let lastKnownNormalWindowId: number | null = null;

  function rememberNormalWindow(window: chrome.windows.Window | undefined) {
    const id = Number(window?.id);
    if (Number.isInteger(id) && id >= 0) lastKnownNormalWindowId = id;
  }

  async function refreshLastFocusedWindow() {
    if (!windows?.getLastFocused) return null;
    try {
      const window = await windows.getLastFocused({ windowTypes: ["normal"] });
      rememberNormalWindow(window);
      return window || null;
    } catch (_error) {
      return null;
    }
  }

  void refreshLastFocusedWindow();
  windows?.onFocusChanged?.addListener?.((windowId) => {
    void rememberWindowIdIfNormal(windowId);
  });
  windows?.onRemoved?.addListener?.((windowId) => {
    if (Number(windowId) === lastKnownNormalWindowId) lastKnownNormalWindowId = null;
  });

  async function rememberWindowIdIfNormal(windowId: unknown) {
    const id = Number(windowId);
    if (!Number.isInteger(id) || id < 0 || typeof windows?.get !== "function") return;
    try {
      const window = await windows.get(id);
      if (window?.type === "normal") rememberNormalWindow(window);
    } catch (_error) {}
  }

  async function create(notificationId: string, options: chrome.notifications.NotificationCreateOptions) {
    const permission = await getPermissionLevel();
    if (permission && permission !== "granted") {
      throw new Error(`notification permission is ${permission}`);
    }
    if (!Number.isInteger(lastKnownNormalWindowId)) await refreshLastFocusedWindow();
    return new Promise<string>((resolve, reject) => {
      notifications!.create(notificationId, options, (id) => {
        const error = runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(id || notificationId);
      });
    });
  }

  async function clear(notificationId: string) {
    if (!notifications?.clear) return false;
    return new Promise<boolean>(resolve => {
      notifications.clear(notificationId, wasCleared => resolve(Boolean(wasCleared)));
    });
  }

  async function getPermissionLevel() {
    if (!notifications?.getPermissionLevel) return "";
    return new Promise<string>(resolve => {
      notifications.getPermissionLevel(level => resolve(level || ""));
    });
  }

  async function isChromeVisuallyFocused() {
    if (!windows?.getAll) return false;
    try {
      const items = await windows.getAll({ windowTypes: ["normal"] });
      const focused = items.find(window => window.focused);
      rememberNormalWindow(focused || items[0]);
      return Boolean(focused);
    } catch (_error) {
      return false;
    }
  }

  return Object.freeze({
    create,
    clear,
    getPermissionLevel,
    isChromeVisuallyFocused,
    getLastKnownWindowId: () => lastKnownNormalWindowId,
  });
}

export function createSessionCompletionNotifier({
  notifications,
  iconUrl = "",
  normalizeSessionId = value => String(value || "").trim(),
  getRuntime = () => ({}),
  getRuntimeCheckpoint = getRuntime,
  getSessions = async () => ({}),
  getTranscript = async () => [],
  getLastToolName = () => "",
  setRuntime = () => {},
  activateWorkingTab = async () => {},
  openSession = async () => false,
  getAutomationRuntime = () => null,
  now = () => "",
}: CompletionNotifierOptions) {
  const notificationSessions = new Map<string, string>();

  async function notifyCompleted(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    const runtime = getRuntime(id);
    const checkpoint = getRuntimeCheckpoint(id) || {};
    if (runtime.status !== "completed" || runtime.running) return false;
    const runId = String(runtime.runId || runtime.endedAt || "completed");
    if (checkpoint.completionNotificationRunId === runId) return false;

    const sessions = await getSessions();
    const session = sessions[id];
    if (!isRootSession(session)) return false;
    if (await shouldSuppress(id)) {
      setRuntime(id, {
        completionNotificationRunId: runId,
        completionNotificationSuppressedReason: "last_send_alert",
        completionNotificationSuppressedAt: now(),
      });
      return false;
    }
    if (await notifications.isChromeVisuallyFocused()) return false;

    const title = String(session?.title || runtime.workingTitle || t("notification.task"));
    const notificationId = `qz_completed_${id}_${runId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 240);
    const createdId = await notifications!.create(notificationId, {
      type: "basic",
      iconUrl,
      title: t("notification.taskCompleted"),
      message: title,
      priority: 2,
      requireInteraction: true,
    });
    notificationSessions.set(createdId, id);
    setRuntime(id, {
      completionNotificationRunId: runId,
      completionNotificationAt: now(),
    });
    return true;
  }

  function handleClick(notificationId: string) {
    let automationSessionId = "";
    try {
      automationSessionId = getAutomationRuntime()?.consumeNotificationSession?.(notificationId) || "";
    } catch (_error) {}
    const sessionId = notificationSessions.get(notificationId) || automationSessionId || parseSessionId(notificationId);
    if (!sessionId) return Promise.resolve(false);

    // chrome.sidePanel.open() consumes the notification click's user gesture.
    // Invoke it synchronously, before activation/clearing crosses an async boundary.
    let openAttempt;
    try {
      openAttempt = Promise.resolve(openSession(sessionId, { notificationId })).catch(() => false);
    } catch (_error) {
      openAttempt = Promise.resolve(false);
    }
    return finishClick(notificationId, sessionId, openAttempt);
  }

  async function finishClick(notificationId: string, sessionId: string, openAttempt: Promise<OpenResult>) {
    await activateWorkingTab(sessionId, { focusWindow: true }).catch(() => null);
    const opened = await openAttempt;
    if (opened !== true && (typeof opened !== "object" || opened.opened !== true)) return false;
    notificationSessions.delete(notificationId);
    await notifications.clear(notificationId).catch(() => false);
    return true;
  }

  async function shouldSuppress(sessionId: string) {
    const transcript = await getTranscript(sessionId).catch(() => []);
    return getLastToolName(transcript) === "send_alert";
  }

  function isRootSession(session: Fields | undefined) {
    if (!session) return true;
    if (session.source === "automation") return false;
    return normalizeParentSessionId(session.parentSessionId) === ROOT_SESSION_ID;
  }

  function parseSessionId(notificationId: string) {
    const match = String(notificationId || "").match(/^(?:qz_completed_|qz_alert_session_|qz_auto_)([a-z0-9]+)_/i);
    return match ? normalizeSessionId(match[1]) : "";
  }

  return Object.freeze({ notifyCompleted, handleClick, shouldSuppress });
}
