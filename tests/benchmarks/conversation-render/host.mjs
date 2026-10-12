import { normalizeRuntimePendingFollowUps, normalizeRuntimePendingSteerings } from "../../../src/sidepanel/features/sessions/session-state.js";
import { timelineGroupTools } from "../../../src/sidepanel/tools/tool-timeline-renderer.js";
import { hashText } from "../../../src/sidepanel/ui/ui-utils.js";
import {
  createSessionRecord,
  createSessionTitle,
} from "../../../src/shared/session/session-codec.js";
import {
  SESSIONS_KEY,
  getSessions,
  normalizeParentSessionId,
  storedSessionKey,
} from "../../../src/shared/session/session-store.js";
import { normalizeSessionListSummary } from "../../../src/shared/session/session-list-summary.js";
import { nowBeijingDateTime } from "../../../src/shared/time-utils.js";
import { installConversationBenchmark } from "./runtime.mjs";

export function createConversationBenchmarkHost(options = {}) {
  async function reset({ debug = true, clearStorage = false } = {}) {
    options.setDebugMode?.(debug !== false);
    options.runController.resetState({ render: false });
    const perfBuffer = options.getPerfTraceBuffer?.() || [];
    perfBuffer.splice(0, perfBuffer.length);
    options.transcriptRenderer.resetState();
    options.transcriptReconcile.reset();
    options.sessionState.reset();
    options.eventRouter.reset();
    options.notifyUi?.({ type: "ui_workspace_reset" });
    options.resetNavigation?.();
    options.resetUi?.();
    options.hideToast?.();
    options.root?.querySelectorAll?.(".tab-btn").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === options.chatTab);
    });
    for (const page of options.getPages?.() || []) {
      page.elements.forEach(element => element?.classList.toggle("hidden", page.id !== options.chatTab));
    }
    if (clearStorage && globalThis.chrome?.storage?.local?.clear) {
      await globalThis.chrome.storage.local.clear();
    }
    await settleFrame();
  }

  async function seedSession(fixture = {}) {
    const sessionId = normalizeSessionId(fixture.sessionId || fixture.session?.id || "benchmark-session");
    if (!sessionId) throw new Error("benchmark fixture missing sessionId");
    const transcript = Array.isArray(fixture.transcript) ? fixture.transcript : [];
    const conversation = fixture.conversation || fixture.sessionRecord?.conversation || [];
    const record = fixture.record || fixture.sessionRecord || createSessionRecord(conversation, transcript);
    const now = nowBeijingDateTime();
    const session = {
      id: sessionId,
      title: createSessionTitle(fixture.title || fixture.session?.title || sessionId),
      titleSource: "fixed",
      parentSessionId: normalizeParentSessionId(fixture.session?.parentSessionId),
      listSummary: normalizeSessionListSummary(fixture.session?.listSummary),
      createdAt: fixture.session?.createdAt || now,
      updatedAt: fixture.session?.updatedAt || now,
      ...(fixture.session || {}),
    };
    session.id = sessionId;
    session.parentSessionId = normalizeParentSessionId(session.parentSessionId);

    const existingSessions = await getSessions().catch(() => ({}));
    await globalThis.chrome?.storage?.local?.set?.({
      [SESSIONS_KEY]: { ...existingSessions, [sessionId]: session },
      [storedSessionKey(sessionId)]: record,
    });
    return { sessionId, session, transcriptCount: transcript.length };
  }

  function configureVisualState({
    running = false,
    pendingFollowUps = [],
    pendingSteerings = [],
    resetOnboarding = false,
  } = {}) {
    options.closeSettings?.();
    options.notifyUi?.({ type: "ui_close_transient" });
    options.chatSearch.close({ restoreFocus: false });
    if (resetOnboarding) options.resetOnboarding?.();
    const sessionId = normalizeSessionId(options.getCurrentSessionId?.());
    if (!sessionId) return { configured: false, reason: "missing-session" };
    if (running) {
      options.runController.start("benchmark-visual-run", {
        sessionId,
        requireConversation: false,
        startedAt: options.nowTimestamp?.(),
      });
    } else {
      options.runController.finish();
    }
    options.queuedFollowups.setQueues({
      followUps: pendingFollowUps,
      steerings: pendingSteerings,
    }, { reason: "benchmark-visual-state" });
    options.runController.renderDock();
    return {
      configured: true,
      sessionId,
      running: options.runController.getStatus() !== options.idleRunState,
      pendingFollowUps: options.normalizePendingFollowUps(
        options.getRuntime(sessionId).pendingFollowUps,
      ).length,
      pendingSteerings: options.normalizePendingSteerings(
        options.getRuntime(sessionId).pendingSteerings,
      ).length,
    };
  }

  function settleFrame() {
    return new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  function recordTranscriptEvent(event = {}) {
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId || event.type === "messages" || event.type === "queue_update") return false;
    const change = options.sessionState.applyEvent({ ...event, sessionId }, {
      runtime: false,
      record: false,
      artifacts: false,
    });
    if (!change.accepted || !change.transcriptChanged) return false;
    options.transcriptRenderer.markChanged(sessionId);
    return true;
  }

  function install() {
    installConversationBenchmark({
      reset,
      seedSession,
      switchToSession: options.switchToSession,
      setCurrentSessionId: options.setCurrentSessionId,
      resetUI: options.resetUi,
      setSessionTranscript: options.transcriptRenderer.setTranscript,
      renderCurrentTranscript: options.transcriptRenderer.renderCurrent,
      recordSessionTranscriptEvent: recordTranscriptEvent,
      scheduleTranscriptCacheRender: options.transcriptRenderer.scheduleRender,
      startRun: options.runController.start,
      finishRun: options.runController.finish,
      perfNow: options.perfNow,
      settleFrame,
      getMessagesElement: () => options.messagesEl,
      getInputElement: () => options.inputEl,
      hasAssistantPlaybackState: options.transcriptRenderer.hasPlaybackState,
      timelineGroupTools: options.timelineGroupTools,
      normalizeSessionId,
      getCurrentSessionId: options.getCurrentSessionId,
      getCurrentTranscript: options.transcriptRenderer.getCurrentTranscript,
      projectTranscript: options.projectTranscript,
      hasPartialTranscript: options.transcriptRenderer.hasPartial,
      getRunStatus: options.runController.getStatus,
      getPerfTraceBuffer: options.getPerfTraceBuffer,
      hashText: options.hashText,
      collectViewportAnchorState: options.collectViewportAnchorState,
      configureVisualState,
      dispatchBackgroundEvent: event => options.eventRouter.handle(event),
      exportSessionDocument: options.sessionExport.createDocument,
      renderSessionDocument: options.sessionExport.createDocumentFromSnapshot,
    });
  }

  return {
    install,
    reset,
    seedSession,
    configureVisualState,
    settleFrame,
  };
}

function normalizeSessionId(value) {
  return value == null ? "" : String(value).trim();
}

// Loaded by the local test server before the application module. Never distributed with the extension.
globalThis.__QZ_INSTALL_CONVERSATION_BENCHMARK__ = ({ root, workspace, chat, sessionState, perf, getCurrentSessionId, resetNavigation, nowTimestamp }) => {
  const host = createConversationBenchmarkHost({
    root, chatTab: "chat", getPages: workspace.ui.getPages,
    messagesEl: chat.elements.messagesEl, inputEl: chat.elements.inputEl,
    sessionState, eventRouter: workspace.eventRouter, runController: chat.runController,
    transcriptRenderer: chat.transcript, transcriptReconcile: chat.reconcile,
    queuedFollowups: chat.queue, chatSearch: chat.search,
    closeSettings: workspace.settingsShell.close, notifyUi: workspace.extensions.notify,
    sessionExport: workspace.sessionExport,
    idleRunState: "idle", getCurrentSessionId, setCurrentSessionId: workspace.setCurrentSessionId,
    getRuntime: id => sessionState.getRuntime(id), normalizePendingFollowUps: normalizeRuntimePendingFollowUps,
    normalizePendingSteerings: normalizeRuntimePendingSteerings, setDebugMode: workspace.appShell.setDebugMode,
    resetNavigation, resetUi: chat.transcript.resetUi, hideToast: chat.toast.hide,
    resetOnboarding: () => workspace.extensions.notify({ type: "ui_onboarding_reset" }),
    switchToSession: workspace.switchToSession,
    nowTimestamp, perfNow: perf.now, getPerfTraceBuffer: perf.buffer, timelineGroupTools,
    projectTranscript: chat.projection.uiHistory, hashText,
    collectViewportAnchorState: chat.scroll.collectViewportAnchorState,
  });
  host.install();
};
