import type { createChatRunController } from "../chat/chat-run-controller.js";
import type { createGoalStripFeature } from "../chat/goal-strip-feature.js";
import type { createToastFeature } from "../../ui/toast-feature.js";
import type { PortMessage } from "./port-client.js";
import type { SidepanelUiRuntime } from "../../capability-host/runtime.js";
interface AppShellOptions {
  root?: Document; input: HTMLTextAreaElement; inputArea?: HTMLElement | null;
  newButton?: HTMLElement | null; caseRecordingButton?: HTMLElement | null;
  sidePanelApi?: Pick<typeof chrome.sidePanel, "onOpened">;
  tabs: Record<string, string> & { CHAT: string };
  ui: SidepanelUiRuntime;
  getCurrentTab?(): string; setCurrentTab?(tab: string): void;
  isDebugEnabled?(): boolean; setDebugEnabled?(enabled: boolean): void;
  runController: Pick<ReturnType<typeof createChatRunController>, "renderDock" | "setSuppressEvents" | "finish">;
  goalStrip: Pick<ReturnType<typeof createGoalStripFeature>, "renderCurrent">;
  toast?: Pick<ReturnType<typeof createToastFeature>, "hide">;
  send?(message: PortMessage): unknown;
  transitionToSession?(id: null, options: { reload: boolean }): Promise<unknown>; resetUi?(): void; onStableViewChange?(): void;
}

export function createAppShellFeature(options: AppShellOptions) {
  let composerFocusFrame = 0;
  let pendingComposerFocus: "request" | "preset_closed" | null = null;
  let started = false;
  let ready = false;
  let unsubscribePages: (() => void) | null = null;
  const navigationButtons = new Map<string, { button: HTMLElement; created: boolean }>();

  function start({ initialTab = options.tabs.CHAT } = {}) {
    if (started) return;
    started = true;
    options.root?.addEventListener("keydown", handleKeyboardShortcut);
    options.root?.addEventListener("visibilitychange", scheduleComposerFocus);
    options.root?.defaultView?.addEventListener?.("pageshow", scheduleComposerFocus);
    options.root?.defaultView?.addEventListener?.("focus", retryComposerFocus);
    options.sidePanelApi?.onOpened?.addListener?.(scheduleComposerFocus);
    options.newButton?.addEventListener("click", startNewChat);
    unsubscribePages = options.ui.subscribeChanges(refreshPages);
    refreshPages();
    renderTab(isValidTab(initialTab) ? initialTab : options.tabs.CHAT, { refresh: false });
  }

  function setReady() {
    ready = true;
    scheduleComposerFocus();
  }

  function stop() {
    if (!started) return;
    started = false;
    ready = false;
    options.root?.removeEventListener("keydown", handleKeyboardShortcut);
    options.root?.removeEventListener("visibilitychange", scheduleComposerFocus);
    options.root?.defaultView?.removeEventListener?.("pageshow", scheduleComposerFocus);
    options.root?.defaultView?.removeEventListener?.("focus", retryComposerFocus);
    options.sidePanelApi?.onOpened?.removeListener?.(scheduleComposerFocus);
    options.newButton?.removeEventListener("click", startNewChat);
    unsubscribePages?.();
    unsubscribePages = null;
    options.ui.deactivatePage();
    for (const { button, created } of navigationButtons.values()) {
      button.removeEventListener("click", handleTabClick);
      if (created) button.remove();
    }
    navigationButtons.clear();
    if (composerFocusFrame) cancelAnimationFrame(composerFocusFrame);
    composerFocusFrame = 0;
    pendingComposerFocus = null;
  }

  function isTabEnabled(tab: unknown) {
    return typeof tab === "string" && options.ui.isPageEnabled(tab);
  }

  function isValidTab(tab: unknown): tab is string {
    return typeof tab === "string" && Boolean(options.ui.getPage(tab)) && isTabEnabled(tab);
  }

  function switchTab(tab: unknown, { userInitiated = false, refresh = true } = {}) {
    if (!isValidTab(tab)) return false;
    const currentTab = options.getCurrentTab?.();
    if (tab === currentTab) return false;
    options.ui.deactivatePage();
    options.toast?.hide();
    renderTab(tab, { refresh });
    options.onStableViewChange?.();
    return true;
  }

  function renderTab(tab: string, { refresh = true } = {}) {
    options.setCurrentTab?.(tab);
    options.root?.querySelectorAll?.<HTMLElement>(".tab-btn").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    for (const page of options.ui.getPages()) {
      page.elements.forEach(element => element?.classList.toggle("hidden", page.id !== tab));
    }
    options.runController.renderDock();
    options.goalStrip.renderCurrent();
    options.ui.activatePage(tab, { refresh });
  }

  function refreshCurrentPanel() {
    const currentTab = options.getCurrentTab?.();
    if (currentTab) options.ui.activatePage(currentTab, { refresh: true });
  }

  function setDebugMode(enabled: unknown) {
    options.setDebugEnabled?.(enabled === true);
    options.ui.emit({ type: "ui_debug_changed", enabled: enabled === true });
    refreshPages();
  }

  function refreshPages() {
    const root = options.root;
    const pages = options.ui.getPages();
    const ids = new Set(pages.map(page => page.id));
    for (const [id, { button, created }] of navigationButtons) {
      if (ids.has(id)) continue;
      button.removeEventListener("click", handleTabClick);
      if (created) button.remove();
      else button.classList.add("hidden");
      navigationButtons.delete(id);
    }
    const navigation = root?.querySelector?.(".header-tabs");
    for (const page of pages) {
      let entry = navigationButtons.get(page.id);
      if (!entry) {
        const existing = page.button || Array.from(root?.querySelectorAll?.<HTMLElement>(".tab-btn") || []).find(button => button.dataset.tab === page.id);
        const button = existing || root?.createElement?.("button");
        if (!button) continue;
        if (!existing) { button.className = "qz-segment-item tab-btn"; button.textContent = page.title; button.setAttribute("type", "button"); }
        button.dataset.tab = page.id;
        button.addEventListener("click", handleTabClick);
        entry = { button, created: !existing };
        navigationButtons.set(page.id, entry);
      }
      entry.button.classList.toggle("hidden", !isTabEnabled(page.id));
      entry.button.classList.toggle("active", page.id === options.getCurrentTab?.());
      navigation?.append(entry.button);
    }
    options.caseRecordingButton?.classList.toggle("hidden", options.isDebugEnabled?.() !== true);
    const current = options.getCurrentTab?.();
    if (started && current && !isValidTab(current)) switchTab(options.tabs.CHAT);
  }

  async function startNewChat() {
    const transitioned = await options.transitionToSession?.(null, { reload: true });
    if (transitioned === false) return;
    options.runController.setSuppressEvents(true);
    options.runController.finish();
    options.resetUi?.();
    switchTab(options.tabs.CHAT);
    scheduleComposerFocus();
    options.onStableViewChange?.();
  }

  function handleKeyboardShortcut(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (closeTopmostTransientUi()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      closeTopmostTransientUi();
      switchTab(options.tabs.CHAT, { userInitiated: true });
      options.input?.focus();
    }
  }

  function closeTopmostTransientUi() {
    return options.ui.closeTopmostOverlay();
  }

  function scheduleComposerFocus(source: unknown = "request") {
    const nextIntent = source === "preset_closed" ? "preset_closed" : "request";
    if (pendingComposerFocus !== "preset_closed") pendingComposerFocus = nextIntent;
    if (!ready) return;
    queueComposerFocus();
  }

  function retryComposerFocus() {
    if (!pendingComposerFocus) return;
    queueComposerFocus();
  }

  function queueComposerFocus() {
    if (composerFocusFrame) cancelAnimationFrame(composerFocusFrame);
    composerFocusFrame = requestAnimationFrame(() => {
      composerFocusFrame = requestAnimationFrame(() => {
        composerFocusFrame = 0;
        if (!pendingComposerFocus) return;
        if (!ready || options.root?.visibilityState === "hidden" || options.root?.hasFocus?.() === false) return;
        const source = pendingComposerFocus;
        pendingComposerFocus = null;
        if (!canFocusComposer()) return;
        if (source === "preset_closed" && options.root?.activeElement === options.input) {
          options.input.blur();
        }
        options.input.focus({ preventScroll: true });
      });
    });
  }

  function canFocusComposer() {
    if (options.getCurrentTab?.() !== options.tabs.CHAT) return false;
    if (!options.input || options.input.disabled || !isElementVisible(options.inputArea)) return false;
    return !options.ui.hasBlockingOverlay();
  }

  function handleTabClick(event: Event) {
    switchTab(event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined, { userInitiated: true });
  }

  return {
    start,
    setReady,
    stop,
    switchTab,
    refreshCurrentPanel,
    refreshPages,
    setDebugMode,
    closeTopmostTransientUi,
    scheduleComposerFocus,
    isTabEnabled,
    isValidTab,
  };
}

function isElementVisible(element: Element | null | undefined) {
  return Boolean(element && !element.classList.contains("hidden"));
}
