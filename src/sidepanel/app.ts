import { optionalSessionId as normalizeSessionIdValue } from "./features/sessions/session-id.js";
import { record } from "./tools/renderer-input.js";
import type { SessionViewEvent } from "./features/sessions/session-state.js";
import type { WorkspaceView } from "./features/app/workspace-view-store.js";
/** Side Panel composition and lifecycle. */

import { transcriptFromConversation } from "../shared/session/session-codec.js";
import { ACTIVE_CONVERSATION_PREFIX } from "../shared/session/session-store.js";
import { nowBeijingDateTime } from "../shared/time-utils.js";
import {
  createSessionState,
  isSessionRuntimeActive as isSessionRuntimeRunning,
  normalizeRuntimePendingFollowUps,
  normalizeRuntimePendingSteerings,
  normalizeSessionGoal,
} from "./features/sessions/session-state.js";
import { formatLiveElapsedMs } from "./features/sessions/session-navigation-feature.js";
import { CHAT_RUN_STATES } from "./features/chat/chat-run-controller.js";
import { createChatWorkspaceFeature } from "./features/chat/chat-workspace-feature.js";
import { createSidepanelPortRuntime } from "./features/app/sidepanel-port-runtime.js";
import { createWorkspaceComposition, runStatusText } from "./features/app/workspace-composition.js";
import {
  loadWorkspaceBootstrap,
  saveWorkspaceView,
} from "./features/app/workspace-view-store.js";
import { createWorkspaceExtensions } from "./features/app/workspace-extensions.js";
import { createPerfTrace } from "./features/dev/perf-trace.js";
import { isConversationBenchmarkHarness } from "./features/dev/test-host.js";

const UI_TABS = Object.freeze({
  CHAT: "chat",
});
const benchmarkHarness = isConversationBenchmarkHarness();
const workspaceBootstrap = await loadWorkspaceBootstrap();
let workspaceWindowId = workspaceBootstrap.windowId;
let workspaceSaveQueue: Promise<unknown> = Promise.resolve();
let currentTab: string = UI_TABS.CHAT;
let currentSessionId: string | null = null;
let sessionSwitchEpoch = 0;
let debugModeEnabled = false;
const perfTraceFeature = createPerfTrace({
  isEnabled: () => debugModeEnabled,
  isBenchmark: isConversationBenchmarkHarness,
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const sessionState = createSessionState();
const extensions = createWorkspaceExtensions();
let chatWorkspaceFeature: ReturnType<typeof createChatWorkspaceFeature>;
let workspaceComposition: ReturnType<typeof createWorkspaceComposition>;

const portRuntime = createSidepanelPortRuntime({
  getCurrentSessionId: () => currentSessionId,
  isTraceEnabled: () => debugModeEnabled,
  shouldKeepAlive: () => (
    chatWorkspaceFeature?.runController.getStatus() !== CHAT_RUN_STATES.IDLE
    || sessionState.someRuntime(isSessionRuntimeRunning)
  ),
});
const sendMsg = portRuntime.send;
chatWorkspaceFeature = createChatWorkspaceFeature({
  root: document,
  workspaceRoot: document.querySelector<HTMLElement>("#app"),
  tabs: UI_TABS,
  sessionState,
  storage: globalThis.chrome?.storage,
  preferenceStorage: globalThis.localStorage,
  activeConversationPrefix: ACTIVE_CONVERSATION_PREFIX,
  transcriptFromConversation,
  getCurrentTab: () => currentTab,
  getCurrentSessionId: () => currentSessionId,
  isCurrentSession: isCurrentSessionId,
  isCurrentSessionEvent,
  getRuntime: getSessionRuntime,
  isRuntimeRunning: isSessionRuntimeRunning,
  normalizePendingFollowUps: normalizeRuntimePendingFollowUps,
  normalizePendingSteerings: normalizeRuntimePendingSteerings,
  normalizeGoal: normalizeSessionGoal,
  getTraceId: portRuntime.getTraceId,
  emitTrace: portRuntime.emitStreamTrace,
  perfTrace: perfTraceFeature.measure,
  startPerfTrace: perfTraceFeature.start,
  nowTimestamp,
  formatLiveElapsedMs,
  liveElapsedTickMs: 100,
  runStatusText,
  send: sendMsg,
  request: portRuntime.request,
  syncKeepAlive: portRuntime.syncKeepAlive,
  createSession: (...args) => workspaceComposition?.navigation.createSession(...args),
  requestConversationSnapshot: (sessionId, options) => workspaceComposition?.navigation.requestConversationSnapshot(sessionId, options),
  extensions,
  hasBlockingOverlay: () => workspaceComposition?.ui.hasBlockingOverlay() === true,
  getEventRouter: () => workspaceComposition?.eventRouter,
});
const {
  btnPickElement,
} = chatWorkspaceFeature.elements;
const elementPickerFeature = chatWorkspaceFeature.elementPicker;

workspaceComposition = createWorkspaceComposition({
  root: document,
  tabs: UI_TABS,
  sessionState,
  chat: chatWorkspaceFeature,
  portRuntime,
  extensions,
  perf: perfTraceFeature,
  initialView: workspaceBootstrap.view,
  onWorkspaceViewChange: persistWorkspaceView,
  getCurrentTab: () => currentTab,
  setCurrentTab: tab => { currentTab = tab; },
  getCurrentSessionId: () => currentSessionId,
  setCurrentSessionIdValue: value => { currentSessionId = value; },
  getSessionSwitchEpoch: () => sessionSwitchEpoch,
  incrementSessionSwitchEpoch: () => ++sessionSwitchEpoch,
  isDebugEnabled: () => debugModeEnabled,
  setDebugEnabled: enabled => { debugModeEnabled = enabled; },
  resetNavigation: () => {
    currentSessionId = null;
    currentTab = UI_TABS.CHAT;
  },
  nowTimestamp,
});


function nowTimestamp() {
  return nowBeijingDateTime();
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function isCurrentSessionEvent(event: Partial<SessionViewEvent>) {
  const sessionId = normalizeSessionIdValue(event?.sessionId);
  return !sessionId || isCurrentSessionId(sessionId);
}

function getSessionRuntime(sessionId: unknown) {
  return sessionState.getRuntime(normalizeSessionIdValue(sessionId));
}



// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

/**
 * UI states: idle → running → idle, with running ↔ waiting_user.
 * Show the status bar while running and the waiting card while waiting_user.
 * Restoring or switching Sessions/tabs replays the transcript independently of the run lifecycle.
 * Accept run events only when they match runController.getActiveRunId().
 */

/**
 * Project persisted Background Session facts into SessionState.transcript.
 * Normalize live, Background, and storage events into that single projection;
 * transcriptRenderer.render() derives the DOM from it. This preserves Session
 * switching, run identity checks, and Service Worker reconnection.
 */
function isCurrentSessionId(sessionId: unknown) {
  if (workspaceComposition) return workspaceComposition.navigation.isCurrentSession(sessionId);
  const id = normalizeSessionIdValue(sessionId);
  return Boolean(currentSessionId && id && id === currentSessionId);
}

await workspaceComposition.ready;
chatWorkspaceFeature.start();

if (benchmarkHarness) {
  await workspaceComposition.start();
  btnPickElement?.classList.remove("hidden");
  if (!globalThis.__QZ_INSTALL_CONVERSATION_BENCHMARK__) throw new Error("Conversation benchmark test hook is missing");
  globalThis.__QZ_INSTALL_CONVERSATION_BENCHMARK__({
    root: document, workspace: workspaceComposition, chat: chatWorkspaceFeature, sessionState,
    perf: perfTraceFeature, getCurrentSessionId: () => currentSessionId, nowTimestamp,
    resetNavigation: () => { currentSessionId = null; currentTab = UI_TABS.CHAT; },
  });
} else {
  elementPickerFeature.installAvailabilityTracking();
  portRuntime.start();
  if (workspaceWindowId !== null) {
    await portRuntime.attachWindow(workspaceWindowId).catch(() => {});
  }
  const configReady = workspaceComposition.ui.getPage(workspaceBootstrap.view.page)
    && !workspaceComposition.ui.isPageEnabled(workspaceBootstrap.view.page)
    ? waitForPortEvent("config", 1200)
    : null;
  sendMsg({ type: "get_config" });
  if (configReady) await configReady;
  await workspaceComposition.start();
  workspaceComposition.connected();
}
workspaceComposition.setReady();
if (workspaceWindowId === null) void attachLateWindow();

async function attachLateWindow() {
  try {
    const currentWindow = await globalThis.chrome?.windows?.getCurrent?.();
    const id = Number(currentWindow?.id);
    if (!Number.isInteger(id) || id < 0) return;
    workspaceWindowId = id;
    await portRuntime.attachWindow(id).catch(() => {});
    const view = workspaceComposition.captureWorkspaceView();
    if (JSON.stringify(view) !== JSON.stringify(workspaceBootstrap.view)) {
      await persistWorkspaceView(view);
    }
  } catch (_error) {
    // The panel remains usable without cross-open restoration.
  }
}

function persistWorkspaceView(view: WorkspaceView) {
  if (workspaceWindowId === null) return Promise.resolve(false);
  workspaceSaveQueue = workspaceSaveQueue.then(() => saveWorkspaceView(
    globalThis.chrome?.storage?.session,
    workspaceWindowId,
    view,
  ));
  return workspaceSaveQueue;
}

function waitForPortEvent(type: string, timeoutMs: number) {
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = portRuntime.onMessage(event => {
      if (record(event).type === type) finish();
    });
    timer = setTimeout(finish, timeoutMs);
  });
}
