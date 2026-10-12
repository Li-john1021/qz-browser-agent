import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import type { GitSkillSource } from "#sdk/shared/skills";
type SourceSummary = Pick<GitSkillSource, "id" | "repositoryUrl" | "browseUrl" | "host" | "namespace" | "name" | "subpath" | "branch" | "skillNames" | "checkedAt"> & { modifiedCount?: number; missingCount?: number };
interface SourceResponse extends Record<string, unknown> {
  sources?: SourceSummary[]; source?: SourceSummary; checkedAt?: string; remoteChanged?: boolean;
  repairAvailable?: boolean; updateAvailable?: boolean; changed?: boolean; count?: number; names?: string[];
  action?: string; deletedCount?: number; preservedModifiedCount?: number;
}
interface GitSourcesPanelOptions {
  signal?: AbortSignal;
  root?: Document | HTMLElement;
  request(type: string, payload: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>>;
  beforeOpen?(): boolean | void | Promise<boolean | void>; onClose?(): void; onSkillsChanged?(): Promise<void>;
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
  choose?: UiExtensionAPI["dialogs"]["choose"];
  toast?: UiExtensionAPI["showToast"];
}
import { formatDisplayDateTime } from "#sdk/shared/format";
import { escapeHtml, escapeHtmlAttribute } from "#sdk/sidepanel/dom";

const REQUEST_TIMEOUT_MS = 180_000;

export function createGitSkillSourcesPanel(options: GitSourcesPanelOptions) {
  const lifecycleSignal = options.signal;
  const root = options.root || document;
  const request = async (type: string, payload: Record<string, unknown>, timeout: number): Promise<SourceResponse> => options.request(type, payload, timeout);
  if (typeof request !== "function") throw new TypeError("Git skill sources panel requires request");
  const panel = root.querySelector("#git-skill-sources-panel");
  const form = root.querySelector("#git-skill-source-form");
  const input = root.querySelector<HTMLInputElement>("#git-skill-source-url");
  const submit = root.querySelector<HTMLButtonElement>("#btn-bind-git-skill-source");
  const closeButton = root.querySelector("#btn-close-git-skill-sources");
  const summary = root.querySelector("#git-skill-sources-summary");
  const list = root.querySelector("#git-skill-sources-list");
  const status = root.querySelector<HTMLElement>("#git-skill-sources-status");
  const beforeOpen = options.beforeOpen || (() => {});
  const onClose = options.onClose || (() => {});
  const onSkillsChanged = options.onSkillsChanged || (async () => {});
  const confirmAction = options.confirm || (async () => false);
  const toast = options.toast || (() => {});
  const chooseAction = options.choose || (async () => null);

  let sources: SourceSummary[] = [];
  let busyKey = "";
  const checkedUpdates = new Map<string, SourceResponse>();

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    bind();
  }, { signal: lifecycleSignal });
  closeButton?.addEventListener("click", () => close(), { signal: lifecycleSignal });
  list?.addEventListener("click", (event) => {
    const button = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("[data-git-source-action]");
    if (!button || !list.contains(button) || busyKey) return;
    const sourceId = button.dataset.sourceId || "";
    if (button.dataset.gitSourceAction === "check") check(sourceId);
    if (button.dataset.gitSourceAction === "update") update(sourceId);
    if (button.dataset.gitSourceAction === "remove") void chooseRemove(sourceId);
  }, { signal: lifecycleSignal });

  async function open() {
    if (await beforeOpen() === false) return false;
    panel?.classList.remove("hidden");
    await load();
    if (!sources.length) requestAnimationFrame(() => input?.focus({ preventScroll: true }));
    return true;
  }

  function close({ restoreList = true } = {}) {
    panel?.classList.add("hidden");
    if (restoreList) onClose();
  }

  async function load() {
    setStatus(t("loadingRepositorySources"), "loading");
    try {
      const result = await request("list_git_skill_sources", {}, 15_000);
      sources = Array.isArray(result?.sources) ? result.sources : [];
      const sourceIds = new Set(sources.map(source => source.id));
      for (const sourceId of checkedUpdates.keys()) {
        if (!sourceIds.has(sourceId)) checkedUpdates.delete(sourceId);
      }
      render();
      setStatus("");
    } catch (error) {
      sources = [];
      render();
      setStatus("");
      showGitError(errorMessage(error, t("couldNotLoadRepositorySources")), t("unableToReadRepositorySources"), () => void load());
    }
  }

  async function bind({ overwrite = false } = {}) {
    const repositoryUrl = String(input?.value || "").trim();
    input?.toggleAttribute("aria-invalid", !repositoryUrl);
    if (!repositoryUrl || busyKey) {
      if (!repositoryUrl) showGitError(t("pasteASupportedGitRepositoryPageUrl"), t("repositoryUrlIsEmpty"));
      return;
    }
    busyKey = "bind";
    render();
    setStatus(t("repositoryPageOpenedIfSignInIsRequiredImportWill"), "loading");
    try {
      const result = await request("bind_git_skill_source", { repositoryUrl, overwrite }, REQUEST_TIMEOUT_MS);
      await handleSyncSuccess(result);
      if (input) input.value = "";
    } catch (error) {
      const confirmation = conflictConfirmation(error, t("connect"));
      if (confirmation && await confirmAction(confirmation)) {
        busyKey = "";
        await bind({ overwrite: true });
        return;
      }
      if (confirmation) setStatus(t("connectionCanceled"));
      else {
        setStatus("");
        showGitError(errorMessage(error, t("couldNotConnectRepository")), t("repositoryConnectionIncomplete"), () => void bind());
      }
    } finally {
      busyKey = "";
      render();
    }
  }

  async function check(sourceId: string) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || busyKey) return;
    busyKey = sourceId;
    render();
    setStatus(t("checking", { name: String(source.name) }), "loading");
    try {
      const result = await request("check_git_skill_source", { sourceId }, REQUEST_TIMEOUT_MS);
      checkedUpdates.set(sourceId, result);
      if (result?.source) {
        sources = sources.map(item => item.id === sourceId
          ? { ...item, ...result.source, checkedAt: result.checkedAt || item.checkedAt }
          : item);
      }
      if (result?.remoteChanged) setStatus(t("hasUpdatesConfirmToApplyThem", { name: String(source.name) }), "success");
      else if (result?.repairAvailable) setStatus(t("isUnchangedRemotelyLocalDifferencesCanBeRestored", { name: String(source.name) }), "success");
      else setStatus(t("isUpToDate", { name: String(source.name) }), "success");
    } catch (error) {
      checkedUpdates.delete(sourceId);
      setStatus("");
      showGitError(errorMessage(error, t("couldNotCheckRepository")), t("repositoryCheckIncomplete"), () => void check(sourceId));
    } finally {
      busyKey = "";
      render();
    }
  }

  async function update(sourceId: string, { overwrite = false } = {}) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || busyKey) return;
    busyKey = sourceId;
    render();
    const checked = checkedUpdates.get(sourceId);
    setStatus(t(checked?.repairAvailable ? "restoringSource" : "updatingPackage", { name: String(source.name) }), "loading");
    try {
      const result = await request("update_git_skill_source", { sourceId, overwrite }, REQUEST_TIMEOUT_MS);
      await handleSyncSuccess(result);
    } catch (error) {
      const confirmation = conflictConfirmation(error, checked?.repairAvailable ? t("restore") : t("update"));
      if (confirmation && await confirmAction(confirmation)) {
        busyKey = "";
        await update(sourceId, { overwrite: true });
        return;
      }
      if (confirmation) setStatus(t("updateCanceled"));
      else {
        setStatus("");
        showGitError(errorMessage(error, t("couldNotUpdateRepository")), t("repositoryUpdateIncomplete"), () => void update(sourceId));
      }
    } finally {
      busyKey = "";
      render();
    }
  }

  async function chooseRemove(sourceId: string) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || busyKey) return;
    const count = Array.isArray(source.skillNames) ? source.skillNames.length : 0;
    const modifiedCount = Math.max(0, Number(source.modifiedCount || 0));
    const installedCount = Math.max(0, count - Number(source.missingCount || 0));
    const removableCount = Math.max(0, installedCount - modifiedCount);
    const choice = await chooseAction({
      title: t("disconnect", { name: String(source.name) }),
      message: modifiedCount
        ? t("localModificationsWillBeKeptAndWillNotBeDeleted", { count: String(modifiedCount) })
        : t("thisSourceContainsInstalledSkills", { count: String(installedCount) }),
      choices: [
        {
          value: "keep",
          label: t("keepSkills"),
          description: t("disconnectTheRepositoryAndKeepTheInstalledContent"),
        },
        {
          value: "delete",
          label: t("removeUnchangedItems"),
          description: t("deleteUnchangedItemsAndKeepLocalModifications", { count: String(removableCount) }),
          tone: "danger",
        },
      ],
    });
    if (choice === "keep") await remove(sourceId, { deleteUnmodifiedSkills: false });
    if (choice === "delete") await remove(sourceId, { deleteUnmodifiedSkills: true });
  }

  async function remove(sourceId: string, { deleteUnmodifiedSkills = false } = {}) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || busyKey) return;
    busyKey = sourceId;
    render();
    setStatus(deleteUnmodifiedSkills ? t("removingUnchangedItemsFrom", { name: String(source.name) }) : t("disconnecting", { name: String(source.name) }), "loading");
    try {
      const result = await request("remove_git_skill_source", { sourceId, deleteUnmodifiedSkills }, 30_000);
      await load();
      await onSkillsChanged();
      const deletedCount = Number(result?.deletedCount || 0);
      const preservedModifiedCount = Number(result?.preservedModifiedCount || 0);
      const removalSummary = preservedModifiedCount
        ? t("disconnectedRemovedKeptLocalModifications", { name: String(source.name), removed: String(deletedCount), preserved: String(preservedModifiedCount) })
        : t("disconnectedRemovedSkills", { name: String(source.name), count: String(deletedCount) });
      setStatus(deleteUnmodifiedSkills ? removalSummary : t("disconnectedSkillsKept", { name: String(source.name) }), "success");
    } catch (error) {
      setStatus("");
      showGitError(
        errorMessage(error, t("couldNotDisconnect")),
        t("disconnectionIncomplete"),
        () => void remove(sourceId, { deleteUnmodifiedSkills }),
      );
    } finally {
      busyKey = "";
      render();
    }
  }

  async function handleSyncSuccess(result: SourceResponse = {}) {
    if (result.source?.id) checkedUpdates.delete(result.source.id);
    await load();
    if (result.changed !== false) await onSkillsChanged();
    const name = result.source?.name || t("repository");
    const count = Number(result.count || result.names?.length || 0);
    if (result.action === "current") setStatus(t("isUpToDate", { name: String(name) }), "success");
    else if (result.action === "repaired") setStatus(t("restoredSkillsFrom", { name: String(name), count: String(count) }), "success");
    else if (result.action === "updated") setStatus(t("updatedSkillsFrom", { name: String(name), count: String(count) }), "success");
    else setStatus(t("connectedImportedSkills", { name: String(name), count: String(count) }), "success");
  }

  function render() {
    if (summary) summary.textContent = sources.length ? t("sources", { count: String(sources.length) }) : t("repositorySources");
    if (submit) {
      submit.disabled = Boolean(busyKey);
      submit.textContent = busyKey === "bind" ? t("connecting") : t("connect");
    }
    if (!list) return;
    if (!sources.length) {
      list.innerHTML = `<div class="git-skill-source-empty">${escapeHtml(t("noRepositoriesConnectedYet"))}</div>`;
      return;
    }
    list.innerHTML = sources.map(renderSource).join("");
  }

  function renderSource(source: SourceSummary) {
    const checked = checkedUpdates.get(source.id);
    const sourceBusy = busyKey === source.id;
    const issueCount = Number(source.modifiedCount || 0) + Number(source.missingCount || 0);
    const meta = [
      t("skillCount", { count: String(Array.isArray(source.skillNames) ? source.skillNames.length : 0) }),
      source.checkedAt ? t("checked", { time: String(formatDisplayDateTime(source.checkedAt) || source.checkedAt) }) : "",
    ].filter(Boolean).join(" · ");
    const locationParts = [source.host, ...String(source.namespace || "").split("/")];
    const location = locationParts.filter(Boolean).join(" / ");
    const issueText = source.modifiedCount
      ? t("localModifications", { count: String(source.modifiedCount) })
      : source.missingCount
        ? t("missing", { count: String(source.missingCount) })
        : "";
    const checkedText = checked?.updateAvailable
      ? (checked.remoteChanged ? t("updateAvailable") : t("restoreAvailable"))
      : checked ? t("upToDate") : "";
    return `
      <article class="git-skill-source-row${issueCount ? " has-issue" : ""}${checked?.updateAvailable ? " has-update" : ""}" data-source-id="${escapeHtmlAttribute(source.id)}">
        <span class="git-skill-source-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 8a6 6 0 0 1-6 6H6"/></svg>
        </span>
        <div class="git-skill-source-main">
          <div class="git-skill-source-title">
            <a href="${escapeHtmlAttribute(source.browseUrl || source.repositoryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(source.name)}</a>
            ${source.branch ? `<span>${escapeHtml(source.branch)}</span>` : ""}
          </div>
          <div class="git-skill-source-location">${escapeHtml(location)}</div>
          <div class="git-skill-source-meta">
            ${source.subpath ? `<span class="git-skill-source-subpath" title="${escapeHtmlAttribute(t("sourceDirectoryTitle", { path: String(source.subpath) }))}">${escapeHtml(t("directoryLabel", { path: String(source.subpath) }))}</span>` : ""}
            <span>${source.subpath ? "· " : ""}${escapeHtml(meta)}</span>
            ${issueText ? `<em>${escapeHtml(issueText)}</em>` : ""}
            ${checkedText ? `<em class="git-skill-source-check-state${checked?.updateAvailable ? " update-available" : ""}">${escapeHtml(checkedText)}</em>` : ""}
          </div>
        </div>
        <div class="git-skill-source-actions">
          ${checked?.updateAvailable ? `<button class="qz-btn qz-btn--secondary qz-btn--xs git-skill-source-apply" type="button" data-git-source-action="update" data-source-id="${escapeHtmlAttribute(source.id)}" title="${escapeHtmlAttribute(checked.repairAvailable ? t("restoreRepositoryVersion") : t("applyRepositoryUpdates"))}" ${busyKey ? "disabled" : ""}>${checked.repairAvailable ? t("restore") : t("update")}</button>` : ""}
          <button class="qz-icon-btn qz-icon-btn--sm git-skill-source-action${sourceBusy ? " is-spinning" : ""}" type="button" data-git-source-action="check" data-source-id="${escapeHtmlAttribute(source.id)}" title="${escapeHtmlAttribute(t("checkForUpdates"))}" aria-label="${escapeHtmlAttribute(t("checkSourceForUpdates", { name: String(source.name) }))}" ${busyKey ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
          </button>
          <button class="qz-icon-btn qz-icon-btn--sm git-skill-source-action" type="button" data-git-source-action="remove" data-source-id="${escapeHtmlAttribute(source.id)}" title="${escapeHtmlAttribute(t("disconnectSource"))}" aria-label="${escapeHtmlAttribute(t("disconnectSourceNamed", { name: String(source.name) }))}" ${busyKey ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m18.84 12.25 1.72-1.71a5.5 5.5 0 0 0-7.78-7.78l-1.71 1.72"/><path d="M5.17 11.75 3.46 13.46a5.5 5.5 0 0 0 7.78 7.78l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>
          </button>
        </div>
      </article>
    `;
  }

  function setStatus(message = "", tone = "") {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function showGitError(message: string, title: string, retry: (() => void) | null = null) {
    toast(message, {
      title,
      tone: "error",
      durationMs: 6000,
      key: "git-skill-source-error",
      actionLabel: typeof retry === "function" ? t("retry") : "",
      onAction: retry,
    });
  }

  return Object.freeze({
    open,
    close,
    load,
    isOpen: () => Boolean(panel && !panel.classList.contains("hidden")),
  });
}

function conflictConfirmation(error: unknown, action: string) {
  const failure = record(error);
  const response = record(record(failure.details).response);
  if (!["name_conflict", "local_changes"].includes(String(failure.code || response.code || ""))) return "";
  const conflicts: unknown[] = Array.isArray(response.conflicts) ? response.conflicts : [];
  const names = conflicts.map(item => record(item).name).filter(Boolean);
  const shown = names.slice(0, 6).join("、");
  const suffix = names.length > 6 ? t("andOthersTotal", { count: String(names.length) }) : "";
  if (String(failure.code || response.code) === "local_changes") {
    return t("containLocalModificationsContinuingToWillOverwriteThemWithThe", { names: String(shown || t("connectSkills")), more: String(suffix), action: String(action) });
  }
  return t("theRepositoryContainsSkillsWithTheSameNamesContinuingTo", { names: String(shown || t("unknownSkill")), more: String(suffix), action: String(action) });
}

function errorMessage(error: unknown, fallback: string) {
  return String(record(error).message || fallback || t("operationFailed")).replace(/^\w+\s+failed:\s*/iu, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
