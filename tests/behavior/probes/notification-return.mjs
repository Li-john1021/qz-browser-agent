#!/usr/bin/env node
import { createSessionCompletionNotifier } from "../../../src/background/services/chrome-notifications.js";

const created = [];
const cleared = [];
const workingTabAttempts = [];
const openedSessions = [];
let canOpenSession = true;
const runtimes = new Map([
  ["session42", { status: "completed", running: false, runId: "run42" }],
]);

const notifier = createSessionCompletionNotifier({
  notifications: {
    isChromeVisuallyFocused: async () => false,
    create: async (id, options) => {
      created.push({ id, options });
      return id;
    },
    clear: async id => {
      cleared.push(id);
      return true;
    },
  },
  normalizeSessionId: value => String(value || "").trim(),
  getRuntime: id => runtimes.get(id) || {},
  getRuntimeCheckpoint: () => ({}),
  getSessions: async () => ({ session42: { id: "session42", parentSessionId: "0", title: "通知返回测试" } }),
  getTranscript: async () => [],
  getLastToolName: () => "",
  setRuntime: () => {},
  activateWorkingTab: async (sessionId, options) => {
    workingTabAttempts.push({ sessionId, options });
    return { activated: false, reason: "no_working_tab" };
  },
  // H16 needs a product-level Session destination, independently of whether the task owns a page tab.
  openSession: async sessionId => {
    openedSessions.push(sessionId);
    return { opened: canOpenSession };
  },
  getAutomationRuntime: () => null,
  now: () => "2026-07-19 12:00:00",
});

await notifier.notifyCompleted("session42");
const completionHandled = await notifier.handleClick(created[0]?.id || "");
const alertHandled = await notifier.handleClick("qz_alert_session_session42_1234_journey");
const automationClick = notifier.handleClick("qz_auto_session42_run42");
const automationRevealStartedSynchronously = openedSessions.length === 3;
const automationHandled = await automationClick;
const clearedAfterAddressableClicks = cleared.length;
canOpenSession = false;
const unaddressedHandled = await notifier.handleClick("qz_alert_session_session42_1235_unaddressed");

const checks = {
  completionNotificationCreated: created.length === 1,
  completionClickHandled: completionHandled === true,
  workingTabAttempted: workingTabAttempts.length === 4,
  relatedSessionOpened: openedSessions.slice(0, 3).every(sessionId => sessionId === "session42"),
  completionNotificationClearedAfterReveal: cleared.includes(created[0]?.id || ""),
  notificationPreservedWhenNoDestination: unaddressedHandled === false && cleared.length === clearedAfterAddressableClicks,
  sendAlertClickAddressable: alertHandled === true,
  automationClickAddressable: automationHandled === true,
  panelOpenStartedInUserGesture: automationRevealStartedSynchronously,
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);

console.log(JSON.stringify({
  schema: "qingzhou.behavior_probe.notification_return.v1",
  journey: "H16",
  passed: failures.length === 0,
  checks,
  observations: {
    created: created.map(item => item.id),
    cleared,
    workingTabAttempts,
    openedSessions,
    alertHandled,
    automationHandled,
    unaddressedHandled,
  },
  failures,
}, null, 2));

process.exitCode = failures.length ? 1 : 0;
