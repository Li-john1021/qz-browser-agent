import { t, tHtml } from "../../i18n/index.js";
import { goalStatusClass } from "../sessions/session-format.js";
export { goalStatusClass } from "../sessions/session-format.js";
import { sessionIdText as normalizeSessionId } from "../sessions/session-id.js";
import type { ClientRuntime, GoalView, SessionViewEvent } from "../sessions/session-state.js";
import type { PortMessage } from "../app/port-client.js";
import { record } from "../../tools/renderer-input.js";

interface GoalStripOptions {
  strip?: HTMLElement | null; inputArea?: HTMLElement | null;
  getCurrentSessionId?(): string | null; getRuntime?(id: string): Partial<ClientRuntime>;
  normalizeGoal?(goal: unknown): GoalView | null; isChatActive?(): boolean; isCurrentSession?(id: string): boolean;
  mergeRuntime?(id: string, runtime: unknown): unknown; nowTimestamp?(): string;
  renderSessions?(options: { requestFreshState: boolean }): unknown;
  request?(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
  applyRuntimeEvent?(id: string, event: SessionViewEvent): unknown;
  scheduleSessionsRefresh?(options: { delay: number }): void;
  showToast?(message: string, options: { tone: string; anchorEl: Element | null }): void;
}

import { escapeHtml } from "../../ui/ui-utils.js";

export function createGoalStripFeature(options: GoalStripOptions = {}) {
  const strip = options.strip || null;
  const inputArea = options.inputArea || null;
  const pendingClearSessionIds = new Set<string>();

  strip?.addEventListener("click", handleClick);

  function renderCurrent() {
    render(options.getCurrentSessionId?.());
  }

  function render(sessionId = options.getCurrentSessionId?.()) {
    if (!strip) return;
    const id = normalizeSessionId(sessionId);
    const goal = options.normalizeGoal?.(id ? options.getRuntime?.(id)?.goal : null) || null;
    if (!id || !goal || options.isChatActive?.() !== true) {
      hide();
      return;
    }

    const statusClass = goalStatusClass(goal.status);
    const title = goalPrimaryText(goal);
    const meta = goalSecondaryText(goal);
    const tooltip = [goalStatusLabel(goal.status), title, meta].filter(Boolean).join(" · ");
    strip.innerHTML = `
      <div class="goal-pill ${statusClass} qz:flex qz:min-h-7.25 qz:items-center qz:gap-1.75 qz:py-0.75 qz:pr-0.75 qz:pl-2" title="${escapeHtml(tooltip)}">
        <svg class="goal-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.25"></circle>
          <circle cx="8" cy="8" r="1.55"></circle>
          <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2"></path>
        </svg>
        <div class="goal-body qz:grid qz:min-w-0 qz:flex-auto qz:gap-0.25">
          <div class="goal-title-row qz:flex qz:min-w-0 qz:items-center qz:gap-1.5">
            <span class="goal-label qz:flex-none">${escapeHtml(goalStatusLabel(goal.status))}</span>
            <span class="goal-title qz:min-w-0 qz:truncate">${escapeHtml(title)}</span>
          </div>
          ${meta ? `<div class="goal-meta qz:min-w-0 qz:truncate">${escapeHtml(meta)}</div>` : ""}
        </div>
        <button class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger goal-clear-btn" type="button" data-goal-action="clear" data-id="${escapeHtml(id)}" title="${tHtml("deleteGoal")}" aria-label="${tHtml("deleteGoal")}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    `;
    strip.classList.remove("hidden");
    inputArea?.classList.add("has-goal");
  }

  function hide() {
    strip?.classList.add("hidden");
    inputArea?.classList.remove("has-goal");
    if (strip) strip.innerHTML = "";
  }

  function applyLocalClear(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return null;
    const previous = options.getRuntime?.(id);
    pendingClearSessionIds.add(id);
    options.mergeRuntime?.(id, {
      ...previous,
      goal: null,
      updatedAt: options.nowTimestamp?.() || "",
    });
    if (options.isCurrentSession?.(id)) renderCurrent();
    Promise.resolve(options.renderSessions?.({ requestFreshState: false })).catch((error) => {
      console.warn("[轻舟] render sessions after local goal clear failed", error);
    });
    return previous;
  }

  async function clear(sessionId: unknown, anchorEl: Element | null = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    const previous = options.getRuntime?.(id);
    const goal = options.normalizeGoal?.(previous?.goal);
    if (!goal) return false;
    applyLocalClear(id);
    try {
      const result = await options.request?.("clear_goal", { sessionId: id }, 8000);
      if (result?.runtime) {
        options.applyRuntimeEvent?.(id, {
          type: "goal_update",
          sessionId: id,
          action: "clear",
          goal: null,
          runtime: record(result.runtime),
        });
      }
      pendingClearSessionIds.delete(id);
      renderCurrent();
      options.scheduleSessionsRefresh?.({ delay: 0 });
      return true;
    } catch (error) {
      pendingClearSessionIds.delete(id);
      options.mergeRuntime?.(id, previous);
      if (options.isCurrentSession?.(id)) renderCurrent();
      options.scheduleSessionsRefresh?.({ delay: 0 });
      options.showToast?.(t("deleteGoalFailed", { error: String(error instanceof Error ? error.message : error) }), { tone: "error", anchorEl });
      return false;
    }
  }

  async function handleClick(event: Event) {
    const actionEl = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-goal-action]") : null;
    if (!actionEl || !strip?.contains(actionEl)) return;
    event.preventDefault();
    event.stopPropagation();
    if (actionEl.dataset.goalAction === "clear") {
      await clear(actionEl.dataset.id || options.getCurrentSessionId?.(), actionEl);
    }
  }

  function isClearPending(sessionId: unknown) {
    return pendingClearSessionIds.has(normalizeSessionId(sessionId));
  }

  function forget(sessionId: unknown) {
    pendingClearSessionIds.delete(normalizeSessionId(sessionId));
  }

  function reset() {
    pendingClearSessionIds.clear();
    hide();
  }

  return {
    renderCurrent,
    render,
    hide,
    clear,
    isClearPending,
    forget,
    reset,
  };
}

export function goalStatusLabel(status = "") {
  switch (status) {
    case "blocked": return t("blockedGoal");
    case "paused": return t("pausedGoal");
    case "complete": return t("completedGoal");
    default: return t("activeGoal");
  }
}


function goalPrimaryText(goal: GoalView) {
  return goal.objective || goal.criteria || goal.progress || goal.next || t("currentGoal");
}

function goalSecondaryText(goal: GoalView) {
  if (goal.next) return t("goalNext", { text: goal.next });
  if (goal.progress) return t("goalProgress", { text: goal.progress });
  if (goal.checkpoint) return t("goalNote", { text: goal.checkpoint });
  if (goal.criteria) return t("goalCriteria", { text: goal.criteria });
  return "";
}

