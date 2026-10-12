import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { stringSessionId as normalizeSessionIdValue } from "#sdk/sidepanel/sessions";
import { createListLayoutMotion, createListExitTransition } from "#sdk/sidepanel/dom";
import type { Automation, AutomationRun, AutomationSchedule } from "#sdk/shared/sessions";
import { normalizeAutomation, normalizeAutomationRun } from "#sdk/shared/sessions";
import type { ArtifactItem, ArtifactSummary } from "../artifacts/artifact-model.js";
import type { createArtifactsFeature } from "../artifacts/artifacts-feature.js";
import type { UiEvent as PortMessage } from "#sdk/sidepanel";
type Run = AutomationRun & { lastMessage?: string };
type Summary = Partial<ArtifactSummary>;
type Artifacts = ReturnType<typeof createArtifactsFeature>;
interface AutomationOptions {
  signal?: AbortSignal;
  root?: Document;
  request(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
  isActive?(): boolean; syncModeUi?(): void; getSearchQuery?(): string;
  appendSystemNote?(message: string): void; switchToSession?(id: string): unknown;
  prepareListRemovalLayer?(): Promise<unknown>; shouldReduceMotion?(): boolean;
  morphListHtml?(element: HTMLElement, html: string): void; listItemKey?(element: Element): string;
  scheduleArtifactHydration?: Artifacts["scheduleListHydration"]; getArtifactSummary?: Artifacts["getSessionSummary"];
  artifactPreviewText?: Artifacts["previewText"]; artifactCompactItems?: Artifacts["compactItems"];
  artifactMetaWithTime?: Artifacts["model"]["artifactMetaWithTime"]; artifactTypeLabel?: Artifacts["typeLabel"];
  canOpenDataArtifact?: Artifacts["canOpenData"]; canOpenFileArtifact?: Artifacts["canOpenFile"];
  dataArtifactActionAttributes?: Artifacts["dataActionAttributes"]; fileArtifactActionAttributes?: Artifacts["fileActionAttributes"];
  artifactStatsText?: Artifacts["statsText"]; clipText?(value: unknown, limit: number): string;
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
}
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const errorMessage = (error: unknown, fallback: string) => String(record(error).message || fallback);

import { createSessionTitle } from "#sdk/shared/sessions";
import { formatDisplayDateTime, nowBeijingDateTime } from "#sdk/shared/format";
import { escapeHtml } from "#sdk/sidepanel/dom";

const SESSION_LIST_FINAL_EXIT_MS = 160;
const SESSION_LIST_LAYOUT_MOVE_MS = 260;

export function createAutomationsFeature(options: AutomationOptions) {
  const root = options.root || document;
  const lifetime = options.signal;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const request = options.request;
  const isActive = options.isActive || (() => false);
  const syncModeUi = options.syncModeUi || (() => {});
  const getSearchQuery = options.getSearchQuery || (() => "");
  const appendSystemNote = options.appendSystemNote || (() => {});
  const switchToSession = options.switchToSession || (() => {});
  const prepareListRemovalLayer = options.prepareListRemovalLayer || (() => Promise.resolve());
  const shouldReduceSessionListMotion = options.shouldReduceMotion || (() => false);
  const morphSessionsListHtml = options.morphListHtml || (() => {});
  const automationListItemKey = options.listItemKey || (() => "");
  const scheduleSessionListArtifactHydration = options.scheduleArtifactHydration || (() => {});
  const getSessionListArtifactSummary = options.getArtifactSummary || (() => null);
  const artifactPreviewText = options.artifactPreviewText || (() => "");
  const artifactCompactItems = options.artifactCompactItems || (() => []);
  const artifactMetaWithTime = options.artifactMetaWithTime || (() => "");
  const artifactTypeLabel = options.artifactTypeLabel || (() => "");
  const canOpenDataArtifact = options.canOpenDataArtifact || (() => false);
  const canOpenFileArtifact = options.canOpenFileArtifact || (() => false);
  const dataArtifactActionAttributes = options.dataArtifactActionAttributes || (() => "");
  const fileArtifactActionAttributes = options.fileArtifactActionAttributes || (() => "");
  const sessionListArtifactStatsText = options.artifactStatsText || (() => "");
  const clipText = options.clipText || ((value, limit) => String(value || "").slice(0, limit));
  const confirmAction = options.confirm || (async () => false);

  if (typeof request !== "function") throw new Error("automations request adapter is required");

  const panel = $("#automations-panel");
  const automationsList = $("#automations-list");
  const btnNewAutomation = $("#btn-new-automation");
  const automationEditor = $("#automation-editor");
  const automationEditorTitle = $("#automation-editor-title");
  const automationTitleInput = $<HTMLInputElement>("#automation-title");
  const automationInstructionInput = $<HTMLTextAreaElement>("#automation-instruction");
  const automationFrequencySelect = $<HTMLSelectElement>("#automation-frequency");
  const automationOnceDateInput = $<HTMLInputElement>("#automation-once-date");
  const automationOnceDateField = $(".automation-once-date-field");
  const automationTimeInput = $<HTMLInputElement>("#automation-time");
  const automationWeekdaySelect = $<HTMLSelectElement>("#automation-weekday");
  const automationWeekdayField = $(".automation-weekday-field");
  const automationMissedPolicySelect = $<HTMLSelectElement>("#automation-missed-policy");
  const automationNotifyPolicySelect = $<HTMLSelectElement>("#automation-notify-policy");
  const btnCancelAutomation = $("#btn-cancel-automation");
  const btnSaveAutomation = $<HTMLButtonElement>("#btn-save-automation");
  const btnCloseAutomationEditor = $("#btn-close-automation-editor");

  let automationsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let automationsRenderInFlight = false;
  let automationsRenderPending = false;
  let automationsListLastHtml = "";
  const listExit = createListExitTransition({
    className: "automation-card-final-exit", keyframes: [{ opacity: 1 }, { opacity: 0 }],
    duration: SESSION_LIST_FINAL_EXIT_MS, easing: "linear",
  });
  let editingAutomationId = "";
  let automationsCache: Automation[] = [];
  let automationRunsById: Record<string, Run[]> = {};
  let automationStatusFilter = "all";
  const pendingAutomationDeleteIds = new Set<string>();
  const expandedAutomationIds = new Set<string>();
  const layoutMotion = createListLayoutMotion({
    root: () => automationsList, selector: ".automation-card[data-automation-id], .automation-run[data-run-id]",
    key: automationListItemKey, reduceMotion: shouldReduceSessionListMotion,
    duration: SESSION_LIST_LAYOUT_MOVE_MS, enterDuration: SESSION_LIST_FINAL_EXIT_MS,
  });

function scheduleAutomationsRefresh({ immediate = false, delay = null }: { immediate?: boolean; delay?: number | null } = {}) {
  if (!isActive()) return;
  if (immediate) {
    renderAutomationsNow();
    return;
  }
  if (automationsRefreshTimer) clearTimeout(automationsRefreshTimer);
  automationsRefreshTimer = setTimeout(() => {
    automationsRefreshTimer = null;
    renderAutomationsNow();
  }, Number.isFinite(delay) ? Math.max(0, delay ?? 0) : 180);
}

async function renderAutomationsNow() {
  if (!isActive()) return;
  syncModeUi();
  if (automationsRefreshTimer) {
    clearTimeout(automationsRefreshTimer);
    automationsRefreshTimer = null;
  }
  if (automationsRenderInFlight) {
    automationsRenderPending = true;
    return;
  }
  automationsRenderInFlight = true;
  try {
    const result = await request("list_automations", { runLimit: 5 }, 8000);
    automationsCache = (Array.isArray(result.automations) ? result.automations : []).map(normalizeAutomation).filter((item): item is Automation => item !== null);
    automationRunsById = Object.fromEntries(Object.entries(record(result.runs)).map(([id, runs]) => [id, (Array.isArray(runs) ? runs : []).map((run: unknown): Run | null => {
      const normalized = normalizeAutomationRun(run);
      return normalized ? { ...normalized, lastMessage: String(record(run).lastMessage || "") } : null;
    }).filter((run): run is Run => run !== null)]));
    scheduleAutomationRunArtifactHydration(automationRunsById);
    renderAutomationsList();
  } catch (err) {
    if (lifetime?.aborted) return;
    commitAutomationsListHtml(`<div class="sessions-empty"><p>${escapeHtml(errorMessage(err, t("couldNotLoadAutomations")))}</p></div>`);
  } finally {
    automationsRenderInFlight = false;
    if (automationsRenderPending) {
      automationsRenderPending = false;
      scheduleAutomationsRefresh();
    }
  }
}

function renderAutomationsList() {
  const query = getSearchQuery().toLowerCase();
  const searched = automationsCache.filter((automation) => {
    if (!query) return true;
    const runs = Array.isArray(automationRunsById[automation.id]) ? automationRunsById[automation.id] : [];
    return [
      automation.title,
      automation.instruction,
      describeAutomationScheduleText(automation.schedule),
      automationStatusText(automation),
      missedPolicyText(automation.missedPolicy),
      notifyPolicyText(automation.notifyPolicy),
      runs.map((run) => `${automationRunTitle(run)} ${automationRunMeta(run)} ${automationRunArtifactSearchText(run)}`).join(" "),
    ].join(" ").toLowerCase().includes(query);
  });
  const list = searched.filter((automation) => automationMatchesStatusFilter(automation, automationStatusFilter));
  const filters = buildAutomationFilters(searched);
  const emptyText = automationsCache.length
    ? query || automationStatusFilter !== "all"
      ? t("noMatchingAutomations")
      : t("noAutomationsYet")
    : t("noAutomationsYet");
  commitAutomationsListHtml(`
    <section class="automation-list-box" aria-label="${escapeHtmlAttribute(t("automationList"))}">
      <div class="automation-list-bar">
        <div class="automation-list-count">${escapeHtml(automationListCountText(list.length, automationsCache.length, query))}</div>
        <div class="automation-filter-tabs" role="tablist" aria-label="${escapeHtmlAttribute(t("filterAutomationStatus"))}">
          ${filters.map((filter) => `
            <button class="automation-filter-btn ${filter.id === automationStatusFilter ? "active" : ""}" type="button" data-automation-action="filter" data-filter="${escapeHtmlAttribute(filter.id)}" aria-selected="${filter.id === automationStatusFilter ? "true" : "false"}">
              <span>${escapeHtml(filter.label)}</span>
              <b>${filter.count}</b>
            </button>
          `).join("")}
        </div>
      </div>
      <div class="automation-list-scroll qz-scroll">
        ${list.length
          ? list.map(renderAutomationCard).join("")
          : `<div class="automation-empty">${escapeHtml(emptyText)}</div>`}
      </div>
    </section>
  `);
}

function commitAutomationsListHtml(html: string) {
  const markup = String(html || "");
  if (!automationsList || automationsListLastHtml === markup) return;
  const scrollTarget = automationsList.querySelector(".automation-list-scroll") || automationsList;
  const scrollTop = scrollTarget.scrollTop;
  if (shouldStageAutomationEmptyTransition(markup)) {
    transitionAutomationListToEmpty(markup, scrollTop);
    return;
  }
  listExit.cancel();
  const previousRects = captureAutomationListItemRects(automationsList);
  morphSessionsListHtml(automationsList, markup);
  const nextScrollTarget = automationsList.querySelector(".automation-list-scroll") || automationsList;
  nextScrollTarget.scrollTop = scrollTop;
  automationsListLastHtml = markup;
  animateAutomationListLayout(previousRects);
}

function shouldStageAutomationEmptyTransition(markup: string) {
  if (!automationsList || shouldReduceSessionListMotion() || !/class="automation-empty/.test(String(markup || ""))) return false;
  const cards = Array.from(automationsList.querySelectorAll<HTMLElement>(".automation-card[data-automation-id]"));
  return Boolean(
    cards.length === 1
    && pendingAutomationDeleteIds.has(cards[0].dataset.automationId || "")
    && !/data-automation-id=/.test(String(markup || ""))
  );
}

function transitionAutomationListToEmpty(markup: string, scrollTop = 0) {
  if (!automationsList) return;
  automationsListLastHtml = markup;
  const cards = Array.from(automationsList.querySelectorAll<HTMLElement>(".automation-card[data-automation-id]"));
  listExit.start(cards, () => {
    automationsList.innerHTML = markup;
    const nextScrollTarget = automationsList.querySelector(".automation-list-scroll") || automationsList;
    nextScrollTarget.scrollTop = scrollTop;
    const empty = automationsList.querySelector(".automation-empty");
    if (!empty) return;
    empty.classList.add("automation-empty-enter");
    requestAnimationFrame(() => {
      if (empty.isConnected) empty.classList.add("is-visible");
    });
  });
}

function renderAutomationCard(automation: Automation) {
  const runs = Array.isArray(automationRunsById[automation.id]) ? automationRunsById[automation.id] : [];
  const expanded = expandedAutomationIds.has(automation.id);
  const running = Boolean(automation.runningRunId);
  const status = automationStatusText(automation);
  const schedule = describeAutomationScheduleText(automation.schedule);
  const next = automationNextRunText(automation);
  const last = automation.lastRunStatus ? t("lastRun", { date: String(automationRunStatusText(automation.lastRunStatus)) }) : t("notRunYet");
  const meta = [schedule, next, last].filter(Boolean).join(" · ");
  const latestRun = runs[0];
  const latestSummary = automationRunArtifactSummary(latestRun);
  const deleting = pendingAutomationDeleteIds.has(automation.id);
  return `
    <article class="automation-card ${expanded ? "expanded" : ""} ${deleting ? "is-deleting" : ""}" data-automation-id="${escapeHtmlAttribute(automation.id)}"${deleting ? ' aria-busy="true"' : ""}>
      <div class="automation-card-head">
        <div class="automation-card-content">
          <div class="automation-card-main" role="button" tabindex="0" data-automation-action="toggle-details" data-id="${escapeHtmlAttribute(automation.id)}" aria-expanded="${expanded ? "true" : "false"}">
            <div class="automation-title-row">
              <div class="automation-title">${escapeHtml(automation.title || t("automations"))}</div>
              ${renderAutomationArtifactMark(latestSummary)}
            </div>
            <div class="automation-meta"><span class="automation-status ${escapeHtml(automationStatusClass(automation))}">${escapeHtml(status)}</span> · ${escapeHtml(meta)}</div>
            <div class="automation-card-preview">${escapeHtml(latestRun ? `${automationRunTitle(latestRun)} · ${automationRunMeta(latestRun)}` : (automation.instruction || t("noInstructionsProvided")))}</div>
          </div>
          ${renderAutomationLatestArtifactLine(latestRun, latestSummary)}
        </div>
        <div class="automation-actions">
          <button class="qz-icon-btn qz-icon-btn--xs icon-btn automation-action-btn" type="button" data-automation-action="run" data-id="${escapeHtmlAttribute(automation.id)}" aria-label="${escapeHtmlAttribute(t("runNow"))}" data-tooltip="${escapeHtmlAttribute(t("runNow"))}" ${running ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14l11-7-11-7Z"/></svg>
          </button>
          <button class="qz-icon-btn qz-icon-btn--xs icon-btn automation-action-btn" type="button" data-automation-action="toggle" data-id="${escapeHtmlAttribute(automation.id)}" data-enabled="${automation.enabled ? "false" : "true"}" aria-label="${escapeHtmlAttribute(automation.enabled ? t("pauseTask") : t("enableTask"))}" data-tooltip="${escapeHtmlAttribute(automation.enabled ? t("pauseTask") : t("enableTask"))}">
            ${automation.enabled
              ? `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v8"/><path d="M7.1 6.8a7 7 0 1 0 9.8 0"/></svg>`}
          </button>
          <button class="qz-icon-btn qz-icon-btn--xs icon-btn automation-action-btn" type="button" data-automation-action="edit" data-id="${escapeHtmlAttribute(automation.id)}" aria-label="${escapeHtmlAttribute(t("edit"))}" data-tooltip="${escapeHtmlAttribute(t("edit"))}">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14 8 2 2"/></svg>
          </button>
          <button class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger icon-btn automation-action-btn " type="button" data-automation-action="delete" data-id="${escapeHtmlAttribute(automation.id)}" aria-label="${escapeHtmlAttribute(deleting ? t("deleting") : t("delete"))}" data-tooltip="${escapeHtmlAttribute(deleting ? t("deleting") : t("delete"))}"${deleting ? ' aria-busy="true" disabled' : ""}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
          <button class="qz-icon-btn qz-icon-btn--xs icon-btn automation-action-btn automation-expand-btn" type="button" data-automation-action="toggle-details" data-id="${escapeHtmlAttribute(automation.id)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${escapeHtmlAttribute(expanded ? t("collapseHistory") : t("expandHistory"))}" data-tooltip="${escapeHtmlAttribute(expanded ? t("collapseHistory") : t("expandHistory"))}">
            ${expanded
              ? `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`}
          </button>
        </div>
      </div>
      ${expanded ? `
        <div class="automation-card-details">
          ${renderAutomationRuns(runs)}
        </div>
      ` : ""}
    </article>
  `;
}

function renderAutomationRuns(runs: Run[]) {
  if (!runs.length) return `<div class="automation-runs empty">${escapeHtml(t("noRunHistory"))}</div>`;
  const expandedRunId = runs.find(run => automationRunArtifactSummary(run)?.total)?.id || "";
  return `
    <div class="automation-runs">
      ${runs.map((run) => {
        const summary = automationRunArtifactSummary(run);
        const showShelf = Boolean(summary?.total && run.id === expandedRunId);
        return `
        <div class="automation-run ${run.sessionId ? "clickable" : ""}" data-run-id="${escapeHtmlAttribute(run.id)}" ${run.sessionId ? `data-automation-action="open-run" data-session-id="${escapeHtmlAttribute(run.sessionId)}" role="button" tabindex="0" aria-label="${escapeHtmlAttribute(t("openConversation"))}"` : ""}>
          <span class="automation-run-signal ${escapeHtml(automationRunSignalClass(run.status))}" title="${escapeHtmlAttribute(automationRunStatusText(run.status))}" aria-label="${escapeHtmlAttribute(automationRunStatusText(run.status))}"></span>
          <div>
            <div class="automation-run-title">${escapeHtml(automationRunTitle(run))}</div>
            <div class="automation-run-meta">${escapeHtml(automationRunMeta(run))}</div>
          </div>
          ${renderAutomationRunArtifactBadge(summary)}
        </div>
        ${showShelf ? renderAutomationArtifactShelf(run, summary) : ""}
      `;
      }).join("")}
    </div>
  `;
}

function scheduleAutomationRunArtifactHydration(runsById: Record<string, Run[]> = {}) {
  const sessions = [];
  for (const runs of Object.values(runsById || {})) {
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const id = normalizeSessionIdValue(run?.sessionId);
      if (!id) continue;
      sessions.push({
        id,
        updatedAt: run.endedAt || run.updatedAt || run.startedAt || run.createdAt || "",
        createdAt: run.createdAt || run.startedAt || "",
      });
    }
  }
  scheduleSessionListArtifactHydration(sessions);
}

function automationRunArtifactSummary(run: Partial<Run> = {}) {
  const sessionId = normalizeSessionIdValue(run?.sessionId);
  return sessionId ? getSessionListArtifactSummary(sessionId) : null;
}

function automationRunArtifactSearchText(run: Partial<Run> = {}) {
  const summary = automationRunArtifactSummary(run);
  if (!summary?.total) return "";
  return `${artifactPreviewText(summary)} ${sessionListArtifactStatsText(summary)}`;
}

function renderAutomationArtifactMark(summary: Summary | null = null) {
  const count = Number(summary?.total || 0);
  if (!count) return "";
  return `
    <span class="automation-artifact-mark" aria-label="${escapeHtmlAttribute(t("latestRunArtifactCount", { count }))}">
      <span>${escapeHtml(t("artifacts"))}</span>
      <b>${count}</b>
    </span>
  `;
}

function renderAutomationLatestArtifactLine(run: Partial<Run> = {}, summary: Summary | null = null) {
  const count = Number(summary?.total || 0);
  const sessionId = normalizeSessionIdValue(run?.sessionId);
  if (!count || !sessionId) return "";
  const preview = artifactPreviewText(summary);
  return `
    <button class="automation-artifact-line" type="button" data-artifact-action="open-panel" data-session-id="${escapeHtmlAttribute(sessionId)}" title="${escapeHtmlAttribute(preview)}" aria-label="${escapeHtmlAttribute(t("openLatestArtifacts", { count }))}">
      <span class="automation-artifact-line-kind">${escapeHtml(t("recent"))}</span>
      <span class="automation-artifact-line-name">${escapeHtml(preview)}</span>
      <span class="automation-artifact-line-open">${escapeHtml(t("open"))}</span>
    </button>
  `;
}

function renderAutomationRunArtifactBadge(summary: Summary | null = null) {
  const count = Number(summary?.total || 0);
  return count ? `<span class="automation-run-artifacts">${escapeHtml(t("artifacts"))} ${count}</span>` : "";
}

function renderAutomationArtifactShelf(run: Partial<Run> = {}, summary: Summary | null = {}) {
  const sessionId = normalizeSessionIdValue(run?.sessionId || summary?.sessionId);
  const count = Number(summary?.total || 0);
  if (!sessionId || !count) return "";
  return `
    <div class="automation-artifact-shelf" data-run-id="${escapeHtmlAttribute(run.id || "")}" aria-label="${escapeHtmlAttribute(t("latestArtifact"))}">
      <div class="automation-artifact-shelf-head">
        <div class="automation-artifact-shelf-title">${escapeHtml(t("latestArtifact"))} <span>${count}</span></div>
      </div>
      <div class="automation-artifact-shelf-list">
        ${artifactCompactItems(summary || {}).map(item => renderAutomationArtifactRow(item, sessionId)).join("")}
      </div>
    </div>
  `;
}

function renderAutomationArtifactRow(item: Partial<ArtifactItem> = {}, sessionId = "") {
  const attrs = automationArtifactRowActionAttributes(item, sessionId);
  const disabled = attrs ? "" : " disabled";
  return `
    <button class="automation-artifact-row" type="button"${attrs}${disabled}>
      <span class="automation-artifact-kind">${escapeHtml(artifactTypeLabel(item.type, item))}</span>
      <span class="automation-artifact-main">
        <span class="automation-artifact-name" title="${escapeHtmlAttribute(item.title || "")}">${escapeHtml(item.title || "")}</span>
        <span class="automation-artifact-meta">${escapeHtml(artifactMetaWithTime(item))}</span>
      </span>
      <span class="automation-artifact-open">${escapeHtml(t("open"))}</span>
    </button>
  `;
}

function automationArtifactRowActionAttributes(item: Partial<ArtifactItem> = {}, sessionId = "") {
  if (item.type === "data" && canOpenDataArtifact(item)) return dataArtifactActionAttributes(item, sessionId);
  if (item.type === "file" && canOpenFileArtifact(item)) return fileArtifactActionAttributes(item, sessionId);
  return "";
}

function buildAutomationFilters(list: Automation[]) {
  return [
    { id: "all", label: t("all"), count: list.length },
    { id: "running", label: t("running"), count: list.filter((item) => item.runningRunId).length },
    { id: "paused", label: t("paused"), count: list.filter((item) => !item.enabled).length },
    { id: "failed", label: t("failed"), count: list.filter(isAutomationFailed).length },
  ];
}

function automationMatchesStatusFilter(automation: Automation, filter: string) {
  switch (filter) {
    case "running": return Boolean(automation.runningRunId);
    case "paused": return !automation.enabled;
    case "failed": return isAutomationFailed(automation);
    default: return true;
  }
}

function isAutomationFailed(automation: Partial<Automation>) {
  return ["error", "aborted", "interrupted"].includes(automation?.lastRunStatus || "");
}

function automationListCountText(filteredCount: number, totalCount: number, query: string) {
  if (!totalCount) return t("0Automations");
  if (query || automationStatusFilter !== "all") return t("filteredAutomationCount", { count: String(filteredCount), total: String(totalCount) });
  return t("automationCount", { count: String(totalCount) });
}

function automationRunTitle(run: Run) {
  let triggerPrefix = "";
  if (run?.triggerType === "manual") triggerPrefix = t("manual");
  else if (run?.triggerType === "catchup" && !run?.delayed) triggerPrefix = t("catchUp");
  const lastMessage = clipText(run?.lastMessage || "", 87);
  if (lastMessage && ["completed", "error", "aborted", "interrupted"].includes(run?.status)) {
    return `${triggerPrefix}${lastMessage}`;
  }
  if (run?.status === "completed") return t("noMessages", { prefix: String(triggerPrefix) });
  const status = automationRunStatusText(run.status);
  return `${triggerPrefix}${status}`;
}

function automationRunMeta(run: Run) {
  const parts = [
    run.startedAt ? formatDisplayDateTime(run.startedAt) : "",
    run.delayed ? t("delayedUntilThisDeviceResumed") : "",
    run.error ? clipText(run.error, 46) : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function automationStatusText(automation: Automation) {
  if (automation.runningRunId) return t("running");
  if (isOnceAutomation(automation) && automation.lastRunId && !automation.enabled && automation.lastRunStatus === "completed") return t("completed");
  if (automation.lastRunStatus === "skipped") return t("skipped");
  if (isOnceAutomation(automation) && automation.lastRunId && !automation.enabled && isAutomationFailed(automation)) {
    return automationRunStatusText(automation.lastRunStatus);
  }
  if (!automation.enabled) return t("pausedStatus");
  return t("scheduled");
}

function automationStatusClass(automation: Automation) {
  if (automation.runningRunId) return "running";
  if (isAutomationFailed(automation)) return "error";
  if (isOnceAutomation(automation) && automation.lastRunId && !automation.enabled) return "skipped";
  if (automation.lastRunStatus === "skipped") return "skipped";
  if (!automation.enabled) return "paused";
  return "idle";
}

function automationRunStatusText(status: string = "") {
  switch (status) {
    case "pending": return t("preparing");
    case "running": return t("running");
    case "completed": return t("succeeded");
    case "error": return t("failedStatus");
    case "aborted": return t("stopped");
    case "interrupted": return t("interrupted");
    case "skipped": return t("skipped");
      default: return status || t("unknown");
  }
}

function automationRunSignalClass(status: string) {
  switch (status) {
    case "completed": return "success";
    case "running": return "running";
    case "pending": return "pending";
    case "error":
    case "aborted":
    case "interrupted":
      return "danger";
    case "skipped": return "muted";
    default: return "muted";
  }
}

function describeAutomationScheduleText(schedule: Partial<AutomationSchedule> = {}) {
  const type = schedule?.type || "daily";
  if (type === "once") return t("onceAt", { date: String(String(schedule.runAt || "").slice(0, 16) || t("timeNotSet")) });
  if (type === "hourly") {
    const minutes = normalizeAutomationIntervalMinutes(schedule.intervalMinutes || (Number(schedule.intervalHours) || 1) * 60);
    return minutes < 60 ? t("everyMinutes", { minutes: String(minutes) }) : t("hourly");
  }
  if (type === "weekly") {
    const weekday = [t("mon"), t("tue"), t("wed"), t("thu"), t("fri"), t("sat"), t("sun")][Math.max(1, Math.min(7, Number(schedule.weekday) || 1)) - 1];
    return t("everyAt", { day: String(weekday), time: String(schedule.time || "09:00") });
  }
  return t("dailyAt", { time: String(schedule.time || "09:00") });
}

function automationNextRunText(automation: Partial<Automation> = {}) {
  const once = isOnceAutomation(automation);
  if (automation.enabled && automation.nextRunAt) {
    return once
      ? t("scheduledDate", { date: String(formatDisplayDateTime(automation.nextRunAt)) })
      : t("next", { date: String(formatDisplayDateTime(automation.nextRunAt)) });
  }
  if (once && automation.lastRunId && !automation.enabled) return automationRunStatusText(automation.lastRunStatus);
  return t("pausedStatus");
}

function isOnceAutomation(automation: Partial<Automation> = {}) {
  return automation?.schedule?.type === "once";
}

function missedPolicyText(policy: string) {
  switch (policy) {
    case "latest_only": return t("latestOnly");
    case "skip": return t("skipMissedRuns");
    default: return t("catchUpOnce");
  }
}

function notifyPolicyText(policy: string) {
  switch (policy) {
    case "always": return t("notifyEveryTime");
    case "silent": return t("silent");
    default: return t("notifyOnFailure");
  }
}

function showAutomationEditor(automation: Automation | null = null) {
  editingAutomationId = automation?.id || "";
  automationEditor?.classList.remove("hidden");
  if (automationEditorTitle) automationEditorTitle.textContent = editingAutomationId ? t("editAutomation") : t("newAutomation");
  if (automationTitleInput) automationTitleInput.value = automation?.title || "";
  if (automationInstructionInput) automationInstructionInput.value = automation?.instruction || "";
  const schedule: Partial<AutomationSchedule> = automation?.schedule || {};
  if (automationFrequencySelect) automationFrequencySelect.value = automationFrequencyValue(schedule);
  const onceRunAt = schedule.type === "once" ? (schedule.runAt || automation?.nextRunAt || "") : "";
  if (automationOnceDateInput) {
    automationOnceDateInput.value = dateInputValueFromBeijingDateTime(onceRunAt) || todayBeijingDateInputValue();
  }
  if (automationTimeInput) automationTimeInput.value = timeInputValueFromBeijingDateTime(onceRunAt) || schedule.time || "09:00";
  if (automationWeekdaySelect) automationWeekdaySelect.value = String(schedule.weekday || 1);
  if (automationMissedPolicySelect) {
    automationMissedPolicySelect.value = automation?.missedPolicy || ((schedule.type || "daily") === "hourly" ? "latest_only" : "run_once");
  }
  if (automationNotifyPolicySelect) automationNotifyPolicySelect.value = automation?.notifyPolicy || "failure";
  syncAutomationScheduleFields();
  setTimeout(() => (automationTitleInput || automationInstructionInput)?.focus(), 0);
}

function hideAutomationEditor() {
  editingAutomationId = "";
  automationEditor?.classList.add("hidden");
}

function syncAutomationScheduleFields() {
  const type = automationFrequencySelect?.value || "daily";
  const once = type === "once";
  if (once && automationOnceDateInput && !automationOnceDateInput.value) {
    automationOnceDateInput.value = todayBeijingDateInputValue();
  }
  automationOnceDateField?.classList.toggle("hidden", !once);
  automationWeekdayField?.classList.toggle("hidden", type !== "weekly");
  const showTime = once || (type !== "hourly" && !type.startsWith("interval:"));
  automationTimeInput?.closest("label")?.classList.toggle("hidden", !showTime);
  if (!editingAutomationId && automationMissedPolicySelect) {
    automationMissedPolicySelect.value = (!once && (type === "hourly" || type.startsWith("interval:"))) ? "latest_only" : "run_once";
  }
}

async function saveAutomationFromEditor() {
  const title = String(automationTitleInput?.value || "").trim();
  const instruction = String(automationInstructionInput?.value || "").trim();
  if (!instruction) {
    appendSystemNote(t("enterWhatThisAutomationShouldDo"));
    automationInstructionInput?.focus();
    return;
  }
  const frequencyValue = automationFrequencySelect?.value || "daily";
  const intervalMinutes = frequencyValue.startsWith("interval:")
    ? normalizeAutomationIntervalMinutes(Number(frequencyValue.split(":")[1]))
    : frequencyValue === "hourly"
      ? 60
      : 0;
  const time = normalizeAutomationTimeInput(automationTimeInput?.value || "09:00");
  const onceDate = normalizeAutomationDateInput(automationOnceDateInput?.value) || todayBeijingDateInputValue();
  const schedule = frequencyValue === "once"
    ? {
      type: "once",
      runAt: `${onceDate}T${time}:00+08:00`,
      date: onceDate,
      time,
    }
    : {
      type: intervalMinutes ? "hourly" : frequencyValue,
      time,
      weekday: Number(automationWeekdaySelect?.value || 1),
      intervalHours: intervalMinutes ? Math.ceil(intervalMinutes / 60) : 1,
      intervalMinutes: intervalMinutes || 60,
    };
  const payload = {
    id: editingAutomationId || undefined,
    title: title || createSessionTitle(instruction),
    instruction,
    schedule,
    missedPolicy: automationMissedPolicySelect?.value || (intervalMinutes && frequencyValue !== "once" ? "latest_only" : "run_once"),
    notifyPolicy: automationNotifyPolicySelect?.value || "failure",
    enabled: true,
  };
  if (btnSaveAutomation) btnSaveAutomation.disabled = true;
  try {
    await request("save_automation", { automation: payload }, 10000);
    hideAutomationEditor();
    scheduleAutomationsRefresh({ immediate: true });
  } catch (err) {
    appendSystemNote(errorMessage(err, t("couldNotSaveAutomation")));
  } finally {
    if (btnSaveAutomation) btnSaveAutomation.disabled = false;
  }
}

function automationFrequencyValue(schedule: Partial<AutomationSchedule> = {}) {
  if (schedule?.type === "once") return "once";
  if (schedule?.type === "hourly") {
    const minutes = normalizeAutomationIntervalMinutes(schedule.intervalMinutes || (Number(schedule.intervalHours) || 1) * 60);
    return minutes === 60 ? "hourly" : `interval:${minutes}`;
  }
  return schedule?.type || "daily";
}

function normalizeAutomationDateInput(value = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeAutomationTimeInput(value = "") {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "09:00";
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function dateInputValueFromBeijingDateTime(value = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2} /.test(text) ? text.slice(0, 10) : "";
}

function timeInputValueFromBeijingDateTime(value = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.slice(11, 16) : "";
}

function todayBeijingDateInputValue() {
  return nowBeijingDateTime().slice(0, 10);
}

function normalizeAutomationIntervalMinutes(value: unknown) {
  const minutes = Math.round(Number(value) || 60);
  const allowed = [5, 15, 30, 60];
  return allowed.reduce((best, item) => (
    Math.abs(item - minutes) < Math.abs(best - minutes) ? item : best
  ), 60);
}

function captureAutomationListItemRects(root: HTMLElement | null) { return layoutMotion.capture(root); }
function animateAutomationListLayout(previousRects: Map<string, DOMRect>) { layoutMotion.animate(previousRects); }

btnNewAutomation?.addEventListener("click", () => {
  showAutomationEditor();
}, { signal: lifetime });

btnCancelAutomation?.addEventListener("click", () => {
  hideAutomationEditor();
}, { signal: lifetime });

btnCloseAutomationEditor?.addEventListener("click", () => {
  hideAutomationEditor();
}, { signal: lifetime });

automationEditor?.querySelector(".automation-editor-backdrop")?.addEventListener("click", () => {
  hideAutomationEditor();
}, { signal: lifetime });

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || automationEditor?.classList.contains("hidden")) return;
  hideAutomationEditor();
}, { signal: lifetime });

automationFrequencySelect?.addEventListener("change", () => {
  syncAutomationScheduleFields();
}, { signal: lifetime });

btnSaveAutomation?.addEventListener("click", async () => {
  await saveAutomationFromEditor();
}, { signal: lifetime });

async function deleteAutomationFromList(automationId: string) {
  const id = String(automationId || "").trim();
  if (!id || pendingAutomationDeleteIds.has(id)) return;
  const index = automationsCache.findIndex(automation => automation.id === id);
  const automation = index >= 0 ? automationsCache[index] : null;
  const runs = automationRunsById[id];
  const wasExpanded = expandedAutomationIds.has(id);
  pendingAutomationDeleteIds.add(id);
  syncAutomationDeleteVisualState(id, true);
  const deletionRequest = request("delete_automation", { automationId: id }, 10000)
    .then(result => ({ result, error: null }))
    .catch(error => ({ result: null, error }));
  await prepareListRemovalLayer();
  automationsCache = automationsCache.filter(item => item.id !== id);
  const nextRunsById = { ...automationRunsById };
  delete nextRunsById[id];
  automationRunsById = nextRunsById;
  expandedAutomationIds.delete(id);
  renderAutomationsList();
  try {
    const outcome = await deletionRequest;
    if (outcome.error) throw outcome.error;
    pendingAutomationDeleteIds.delete(id);
    hideAutomationEditor();
    scheduleAutomationsRefresh({ delay: SESSION_LIST_LAYOUT_MOVE_MS + 80 });
  } catch (err) {
    pendingAutomationDeleteIds.delete(id);
    if (automation) {
      const restored = [...automationsCache];
      restored.splice(Math.min(Math.max(index, 0), restored.length), 0, automation);
      automationsCache = restored;
    }
    if (runs) automationRunsById = { ...automationRunsById, [id]: runs };
    if (wasExpanded) expandedAutomationIds.add(id);
    renderAutomationsList();
    scheduleAutomationsRefresh({ immediate: true });
    throw err;
  }
}

function syncAutomationDeleteVisualState(automationId: string, deleting: boolean) {
  const id = String(automationId || "").trim();
  if (!id || !automationsList) return;
  const card = Array.from(automationsList.querySelectorAll<HTMLElement>(".automation-card[data-automation-id]"))
    .find(item => item.dataset.automationId === id);
  if (!card) return;
  card.classList.toggle("is-deleting", Boolean(deleting));
  card.setAttribute("aria-busy", deleting ? "true" : "false");
  if (!deleting) card.removeAttribute("aria-busy");
  const button = card.querySelector<HTMLButtonElement>('.automation-action-btn[data-automation-action="delete"]');
  if (!button) return;
  button.disabled = Boolean(deleting);
  button.toggleAttribute("aria-busy", Boolean(deleting));
  const label = deleting ? t("deleting") : t("delete");
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

automationsList?.addEventListener("click", async (e) => {
  const actionEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>("[data-automation-action]");
  if (!actionEl) return;
  e.stopPropagation();
  const action = actionEl.dataset.automationAction;
  const id = actionEl.dataset.id || "";
  if (id && pendingAutomationDeleteIds.has(id)) return;
  try {
    if (action === "filter") {
      const filter = String(actionEl.dataset.filter || "all");
      automationStatusFilter = ["all", "running", "paused", "failed"].includes(filter) ? filter : "all";
      renderAutomationsList();
    } else if (action === "toggle-details") {
      toggleAutomationDetails(id);
    } else if (action === "run") {
      if (actionEl instanceof HTMLButtonElement) actionEl.disabled = true;
      await request("run_automation", { automationId: id }, 10000);
      scheduleAutomationsRefresh({ immediate: true });
    } else if (action === "toggle") {
      await request("toggle_automation", {
        automationId: id,
        enabled: actionEl.dataset.enabled === "true",
      }, 8000);
      scheduleAutomationsRefresh({ immediate: true });
    } else if (action === "edit") {
      const automation = automationsCache.find((item) => item.id === id);
      if (automation) showAutomationEditor(automation);
    } else if (action === "delete") {
      if (!await confirmAction({
        title: t("deleteAutomation"),
        message: t("thisTaskAndItsRunHistoryWillBePermanently"),
        confirmLabel: t("delete"),
        tone: "danger",
      })) return;
      await deleteAutomationFromList(id);
    } else if (action === "open-run") {
      const sessionId = normalizeSessionIdValue(actionEl.dataset.sessionId);
      if (sessionId) switchToSession(sessionId);
    }
  } catch (err) {
    appendSystemNote(errorMessage(err, t("automationOperationFailed")));
    scheduleAutomationsRefresh({ immediate: true });
  } finally {
    if (action === "run" && actionEl instanceof HTMLButtonElement) actionEl.disabled = false;
  }
}, { signal: lifetime });

automationsList?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const actionEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>('.automation-card-main[data-automation-action="toggle-details"]');
  if (!actionEl) {
    const runEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>('.automation-run[data-automation-action="open-run"]');
    if (!runEl) return;
    e.preventDefault();
    const sessionId = normalizeSessionIdValue(runEl.dataset.sessionId);
    if (sessionId) switchToSession(sessionId);
    return;
  }
  e.preventDefault();
  toggleAutomationDetails(actionEl.dataset.id || "");
}, { signal: lifetime });

function toggleAutomationDetails(id: string) {
  const automationId = String(id || "").trim();
  if (!automationId) return;
  if (expandedAutomationIds.has(automationId)) expandedAutomationIds.delete(automationId);
  else expandedAutomationIds.add(automationId);
  renderAutomationsList();
}

  function closeTopmostTransientUi() {
    if (!automationEditor || automationEditor.classList.contains("hidden")) return false;
    hideAutomationEditor();
    return true;
  }

  function setVisible(visible: boolean) {
    panel?.classList.toggle("hidden", !visible);
    btnNewAutomation?.classList.toggle("hidden", !visible);
    if (!visible) hideAutomationEditor();
  }

  function reset() {
    listExit.cancel();
    if (automationsRefreshTimer) clearTimeout(automationsRefreshTimer);
    automationsRefreshTimer = null;
    automationsRenderInFlight = false;
    automationsRenderPending = false;
    automationsListLastHtml = "";
    automationsCache = [];
    automationRunsById = {};
    automationStatusFilter = "all";
    pendingAutomationDeleteIds.clear();
    expandedAutomationIds.clear();
    hideAutomationEditor();
  }

  return {
    panel,
    editor: automationEditor,
    setVisible,
    scheduleRefresh: scheduleAutomationsRefresh,
    renderNow: renderAutomationsNow,
    openEditor: showAutomationEditor,
    closeEditor: hideAutomationEditor,
    closeTopmostTransientUi,
    reset,
  };
}
