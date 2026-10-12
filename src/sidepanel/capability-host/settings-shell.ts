import { t } from "../i18n/index.js";
import type { UiOverlay, UiSettingsPort, UiSettingsSection } from "../../sdk/sidepanel/ui.js";

type SectionState = Parameters<UiSettingsPort["setState"]>[1];
interface SectionActivation {
  section: UiSettingsSection;
  controller: AbortController;
  saving?: object;
}
interface SettingsTab {
  id: string;
  title: string;
  order?: number;
  sections: UiSettingsSection[];
}
interface SectionCatalog {
  getSettingsSections(): readonly UiSettingsSection[];
  subscribeChanges(listener: () => void): () => void;
}

/** The shell owns navigation and cancellation; each contribution owns its form and draft. */
export function createSettingsShell(root: Document, onError: (error: unknown) => void = console.warn) {
  const panel = root.querySelector<HTMLElement>("#settings-panel")!;
  const content = panel.querySelector<HTMLElement>(".settings-content")!;
  const tabs = panel.querySelector<HTMLElement>(".settings-tabs")!;
  const footer = panel.querySelector<HTMLElement>("#settings-save-state")!;
  const status = panel.querySelector<HTMLElement>("#settings-save-status")!;
  const saveButton = panel.querySelector<HTMLButtonElement>("#btn-save-settings")!;
  const version = panel.querySelector<HTMLElement>("#settings-version-muted");
  const events = new AbortController();
  const states = new Map<string, SectionState>();
  const buttons = new Map<string, HTMLButtonElement>();
  const tabPanels = new Map<string, HTMLElement>();
  const active = new Map<string, SectionActivation>();
  let catalog: SectionCatalog | null = null;
  let unsubscribe = () => {};
  let sections: readonly UiSettingsSection[] = [];
  let groups: SettingsTab[] = [];
  let selectedId = "";
  let openGeneration = 0;
  let activationRevision = 0;
  let open = false;

  function isVisible(section: UiSettingsSection) {
    try { return section.visible?.() !== false; }
    catch (error) { onError(error); return false; }
  }

  function visibleGroups() {
    return groups.filter(group => group.sections.some(isVisible));
  }
  function currentMembers() {
    return (groups.find(group => group.id === selectedId)?.sections || [])
      .map(section => active.get(section.id)).filter((owner): owner is SectionActivation => Boolean(owner));
  }
  function owns(owner: SectionActivation) {
    return active.get(owner.section.id) === owner && !owner.controller.signal.aborted;
  }
  function canSave(owner: SectionActivation) {
    const state = states.get(owner.section.id);
    return Boolean(owner.section.save) && state?.disabled !== true && state?.busy !== true;
  }
  function setState(id: string, state: SectionState) {
    states.set(id, { ...states.get(id), ...state });
    if (active.has(id)) renderState();
  }
  function renderState() {
    const members = currentMembers();
    const entries = members.map(owner => states.get(owner.section.id) || {});
    const busy = members.some((owner, index) => owner.saving || entries[index]?.busy);
    // Preserve each member's notice, including a successful save that needs a later restart.
    // Errors lead the shared status instead of being overwritten by another member's success.
    const messages = [...entries.filter(state => state.tone === "error"), ...entries.filter(state => state.tone !== "error")];
    const genericSaved = (state: SectionState) => state.tone === "saved" && state.text === t("saved");
    const informative = messages.some(state => state.text && !genericSaved(state));
    status.textContent = [...new Set(messages.filter(state => !informative || !genericSaved(state))
      .map(state => state.text).filter(Boolean))].join("\n");
    status.dataset.tone = entries.some(state => state.tone === "error") ? "error"
      : busy ? "muted" : entries.find(state => state.tone === "dirty")?.tone || entries.find(state => state.text)?.tone || "muted";
    const label = busy ? t("saving") : t("save");
    saveButton.textContent = members.length === 1 ? entries[0]?.saveLabel || label : label;
    saveButton.disabled = busy || !members.some(canSave);
  }
  function fail(error: unknown, owner: SectionActivation) {
    if (!owns(owner)) return;
    setState(owner.section.id, { text: error instanceof Error ? error.message : t("settingsFailed"), tone: "error" });
    onError(error);
  }
  function deactivate(owner: SectionActivation) {
    if (active.get(owner.section.id) !== owner) return;
    active.delete(owner.section.id);
    owner.controller.abort();
    try { Promise.resolve(owner.section.deactivate?.()).catch(onError); } catch (error) { onError(error); }
  }
  function syncActive() {
    const revision = ++activationRevision;
    const tabId = selectedId;
    const members = open ? groups.find(group => group.id === selectedId)?.sections.filter(isVisible) || [] : [];
    for (const owner of active.values()) {
      if (revision !== activationRevision) return;
      if (!members.includes(owner.section)) deactivate(owner);
    }
    for (const section of members) {
      // A member callback may synchronously close, navigate, or refresh the catalog.
      if (revision !== activationRevision || !open || selectedId !== tabId) return;
      if (!groups.find(group => group.id === tabId)?.sections.includes(section) || !isVisible(section)) continue;
      if (active.has(section.id)) continue;
      const owner = { section, controller: new AbortController() };
      active.set(section.id, owner);
      try {
        Promise.resolve(section.activate?.({ signal: owner.controller.signal, refresh: false }))
          .catch(error => fail(error, owner));
      } catch (error) { fail(error, owner); }
    }
  }
  function revealSelectedTab() {
    if (open) buttons.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function renderSelection() {
    for (const group of groups) {
      const selected = group.id === selectedId;
      tabPanels.get(group.id)!.classList.toggle("hidden", !selected);
      const button = buttons.get(group.id)!;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      for (const section of group.sections) section.element.classList.toggle("hidden", !isVisible(section));
    }
    renderState();
  }
  function select(id: string, reveal = true) {
    const group = visibleGroups().find(item => item.id === id);
    if (!group) return;
    selectedId = group.id;
    syncActive();
    renderSelection();
    if (reveal) revealSelectedTab();
  }
  function refresh(requestedId?: string) {
    const focusedElement = root.activeElement as HTMLElement | null;
    const focusedTabId = [...buttons].find(([, button]) => button === focusedElement)?.[0];
    const focusedSection = sections.find(section => focusedElement && section.element.contains(focusedElement));
    const next = [...catalog?.getSettingsSections() || []]
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
    for (const section of sections) {
      if (next.includes(section)) continue;
      const owner = active.get(section.id);
      if (owner) deactivate(owner);
      states.delete(section.id);
      section.element.remove();
    }
    sections = next;
    const byTab = new Map<string, SettingsTab>();
    for (const section of sections) {
      const descriptor = section.tab || section;
      let group = byTab.get(descriptor.id);
      if (!group) {
        group = { id: descriptor.id, title: descriptor.title, order: descriptor.order, sections: [] };
        byTab.set(group.id, group);
      }
      group.sections.push(section);
    }
    groups = [...byTab.values()].sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
    for (const [id, button] of buttons) {
      if (byTab.has(id)) continue;
      button.remove();
      buttons.delete(id);
      tabPanels.get(id)?.remove();
      tabPanels.delete(id);
    }
    for (const group of groups) {
      let button = buttons.get(group.id);
      if (!button) {
        button = root.createElement("button");
        button.id = `settings-tab-${group.id}`;
        button.type = "button";
        button.className = "qz-segment-item settings-tab";
        button.setAttribute("role", "tab");
        button.dataset.settingsTab = group.id;
        button.addEventListener("click", () => select(group.id), { signal: events.signal });
        buttons.set(group.id, button);
      }
      let tabPanel = tabPanels.get(group.id);
      if (!tabPanel) {
        tabPanel = root.createElement("div");
        tabPanel.id = `settings-tab-panel-${group.id}`;
        tabPanel.className = "settings-body settings-tab-panel settings-tab-group";
        tabPanel.setAttribute("role", "tabpanel");
        tabPanel.setAttribute("aria-labelledby", button.id);
        tabPanels.set(group.id, tabPanel);
      }
      const visible = group.sections.some(isVisible);
      button.textContent = group.title;
      button.classList.toggle("hidden", !visible);
      button.setAttribute("aria-hidden", String(!visible));
      if (!visible) button.tabIndex = -1;
      button.setAttribute("aria-controls", tabPanel.id);
      let beforeSection: Element | null = null;
      for (const section of [...group.sections].reverse()) {
        section.element.id ||= `settings-panel-${section.id}`;
        section.element.dataset.settingsPanel = section.id;
        section.element.classList.remove("settings-tab-panel");
        section.element.classList.add("settings-body", "settings-section");
        section.element.setAttribute("role", "region");
        section.element.removeAttribute("aria-labelledby");
        section.element.setAttribute("aria-label", section.title);
        if (section.element.parentElement !== tabPanel || section.element.nextElementSibling !== beforeSection) {
          tabPanel.insertBefore(section.element, beforeSection);
        }
        beforeSection = section.element;
      }
    }
    // Leave existing nodes and member activations intact on an ordinary refresh.
    let before: Element = footer;
    let beforeTab: Element | null = null;
    for (const group of [...groups].reverse()) {
      const tabPanel = tabPanels.get(group.id)!;
      if (tabPanel.nextElementSibling !== before) content.insertBefore(tabPanel, before);
      const button = buttons.get(group.id)!;
      if (button.parentElement !== tabs || button.nextElementSibling !== beforeTab) tabs.insertBefore(button, beforeTab);
      before = tabPanel;
      beforeTab = button;
    }
    const visible = visibleGroups();
    tabs.dataset.tabCount = String(visible.length);
    const requestedTabId = requestedId && (sections.find(section => section.id === requestedId)?.tab?.id || requestedId);
    // Before the first open, late registrations may still change the first tab.
    const nextId = (requestedTabId ? visible.find(group => group.id === requestedTabId)?.id
      : openGeneration > 0 ? visible.find(group => group.id === selectedId)?.id : undefined) || visible[0]?.id;
    if (nextId) select(nextId, selectedId !== nextId);
    else {
      selectedId = "";
      syncActive();
      renderSelection();
    }
    const lostTab = focusedTabId && !visible.some(group => group.id === focusedTabId);
    const lostSection = focusedSection && (!sections.includes(focusedSection) || !isVisible(focusedSection)
      || (focusedSection.tab?.id || focusedSection.id) !== selectedId);
    if (open && (lostTab || lostSection)) {
      const target = nextId ? buttons.get(nextId) : panel.querySelector<HTMLButtonElement>("#btn-close-settings");
      target?.focus({ preventScroll: true });
      revealSelectedTab();
    } else if (open && focusedElement?.isConnected && root.activeElement !== focusedElement && (focusedTabId || focusedSection)) {
      focusedElement.focus({ preventScroll: true });
    }
  }
  function close() {
    if (!open) return;
    open = false;
    panel.classList.add("hidden");
    syncActive();
    renderState();
  }
  const port: UiSettingsPort = {
    open(id) {
      if (!open) openGeneration += 1;
      open = true;
      panel.classList.remove("hidden");
      refresh(id);
      revealSelectedTab();
    },
    close,
    currentSection: () => open ? selectedId : "",
    getOpenGeneration: () => openGeneration,
    refresh: () => refresh(),
    setState,
  };
  root.querySelector("#btn-settings")?.addEventListener("click", () => port.open(), { signal: events.signal });
  panel.querySelector("#btn-close-settings")?.addEventListener("click", close, { signal: events.signal });
  panel.querySelector(".settings-backdrop")?.addEventListener("click", close, { signal: events.signal });
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const visible = visibleGroups().map(group => buttons.get(group.id)!);
    const current = visible.findIndex(button => button === event.target);
    if (current < 0 || !visible.length) return;
    event.preventDefault();
    const direction = root.defaultView?.getComputedStyle(tabs).direction === "rtl" ? -1 : 1;
    const step = (event.key === "ArrowRight" ? 1 : -1) * direction;
    const index = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
      : (current + step + visible.length) % visible.length;
    const button = visible[index]!;
    button.focus({ preventScroll: true });
    select(button.dataset.settingsTab!);
  }, { signal: events.signal });
  saveButton.addEventListener("click", async () => {
    if (saveButton.disabled) return;
    const group = currentMembers();
    const beforeStates = new Map(group.map(owner => [owner, states.get(owner.section.id)]));
    const members = group.filter(canSave);
    const ticket = {};
    // Mark the whole snapshot before invoking callbacks, which may synchronously publish state.
    for (const owner of members) owner.saving = ticket;
    renderState();
    const results = await Promise.all(members.map(async owner => {
      if (!owns(owner)) return false;
      const before = states.get(owner.section.id);
      try {
        const result = await owner.section.save!({ signal: owner.controller.signal, refresh: false });
        if (owns(owner) && states.get(owner.section.id) === before) {
          setState(owner.section.id, result === false
            ? { text: t("settingsFailed"), tone: "error" }
            : { text: t("saved"), tone: "saved" });
        }
        return owns(owner) && result !== false;
      } catch (error) { fail(error, owner); return false; }
      finally {
        if (owns(owner) && owner.saving === ticket) { delete owner.saving; renderState(); }
      }
    }));
    // Apply shared-save effects only after every write settles. A previously saved member
    // still participates when a sibling is retried; unrelated, unchanged validation stays local.
    const ready = () => currentMembers().length === group.length && group.every(owner => {
      const state = states.get(owner.section.id);
      return owns(owner) && !owner.saving && !state?.busy && state?.tone !== "dirty"
        && (state?.tone !== "error" || (!members.includes(owner) && state === beforeStates.get(owner)));
    });
    if (!results.every(Boolean) || !ready()) return;
    for (const owner of group) {
      if (!ready()) break;
      try { await owner.section.afterSave?.({ signal: owner.controller.signal, refresh: false }); }
      catch (error) { fail(error, owner); break; }
    }
  }, { signal: events.signal });
  const currentVersion = globalThis.chrome?.runtime?.getManifest?.()?.version;
  if (version) version.textContent = currentVersion ? t("currentVersion", { version: currentVersion }) : "";
  const overlay: UiOverlay = {
    id: "settings-shell", priority: 80,
    close: () => { if (!open) return false; close(); return true; },
    blocksFocus: () => open,
  };
  return {
    ...port, port, overlay,
    connect(source: SectionCatalog) { unsubscribe(); catalog = source; unsubscribe = source.subscribeChanges(refresh); refresh(); },
    dispose() { close(); unsubscribe(); events.abort(); },
  };
}
