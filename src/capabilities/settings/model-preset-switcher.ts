import { t } from "./i18n.js";
interface PresetInput { id?: unknown; name?: unknown; label?: unknown; provider?: unknown; providerLabel?: unknown; model?: unknown }
type PresetEntry = ReturnType<typeof normalizePresetEntries>[number];
export interface PresetUsage { selections?: Record<string, unknown>; transitions?: Record<string, Record<string, unknown>> }
interface RankOptions { activePresetId?: string; presetUsage?: PresetUsage }
interface PresetSwitcherOptions {
  root?: Document; signal?: AbortSignal; getPresets?(): PresetInput[]; getActivePresetId?(): string; getPresetUsage?(): PresetUsage;
  onClose?(): void; applyPreset?(id: string): Promise<unknown>;
}

export function createModelPresetSwitcher(options: PresetSwitcherOptions = {}) {
  const root = options.root || document;
  const dialogNode = root.querySelector<HTMLDialogElement>("#model-preset-switcher");
  const inputNode = root.querySelector<HTMLInputElement>("#model-preset-switcher-input");
  const listNode = root.querySelector<HTMLElement>("#model-preset-switcher-list");
  const statusNode = root.querySelector<HTMLElement>("#model-preset-switcher-status");
  if (!dialogNode || !inputNode || !listNode || !statusNode) {
    throw new Error("model preset switcher elements are required");
  }

  const dialog = dialogNode, input = inputNode, list = listNode, status = statusNode;

  let entries: PresetEntry[] = [];
  let matches: PresetEntry[] = [];
  let activeIndex = -1;
  let loading = false;
  let applying = false;
  let composing = false;
  let errorMessage = "";
  let pendingFocus: { select: boolean } | null = null;

  input.addEventListener("input", () => {
    errorMessage = "";
    updateMatches();
  }, { signal: options.signal });
  input.addEventListener("compositionstart", () => { composing = true; }, { signal: options.signal });
  input.addEventListener("compositionend", () => { composing = false; }, { signal: options.signal });
  input.addEventListener("keydown", handleKeydown, { signal: options.signal });
  list.addEventListener("click", (event) => {
    const item = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("[data-model-preset-index]");
    if (!item || applying) return;
    activeIndex = Number(item.dataset.modelPresetIndex);
    void applyActive();
  }, { signal: options.signal });
  list.addEventListener("mousemove", (event) => {
    const item = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("[data-model-preset-index]");
    if (!item || applying) return;
    const index = Number(item.dataset.modelPresetIndex);
    if (!Number.isInteger(index) || index === activeIndex) return;
    activeIndex = index;
    renderSelection();
  }, { signal: options.signal });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (composing) return;
    close();
  }, { signal: options.signal });
  dialog.addEventListener("close", () => {
    pendingFocus = null;
    options.onClose?.();
  }, { signal: options.signal });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  }, { signal: options.signal });
  root.defaultView?.addEventListener?.("focus", retryInputFocus, { signal: options.signal });

  function open({ loading: nextLoading = false } = {}) {
    loading = nextLoading;
    applying = false;
    composing = false;
    errorMessage = "";
    input.value = "";
    refreshEntries();
    if (!dialog.open) dialog.showModal();
    requestInputFocus({ select: true });
    return true;
  }

  function close() {
    if (!dialog.open) return false;
    pendingFocus = null;
    dialog.close();
    applying = false;
    loading = false;
    composing = false;
    errorMessage = "";
    return true;
  }

  function closeIfOpen() {
    return close();
  }

  function refresh() {
    loading = false;
    refreshEntries();
  }

  function setError(message: unknown) {
    loading = false;
    errorMessage = String(message || t("couldNotLoadModelPresets"));
    render();
  }

  function isOpen() {
    return dialog.open;
  }

  function requestInputFocus({ select = false } = {}) {
    pendingFocus = { select };
    queueMicrotask(flushInputFocus);
  }

  function retryInputFocus() {
    if (pendingFocus) queueMicrotask(flushInputFocus);
  }

  function flushInputFocus() {
    if (!pendingFocus || !dialog.open) {
      pendingFocus = null;
      return false;
    }
    if (root.hasFocus?.() === false) return false;
    const { select } = pendingFocus;
    pendingFocus = null;
    input.focus({ preventScroll: true });
    if (select) input.select();
    return true;
  }

  function refreshEntries() {
    entries = normalizePresetEntries(options.getPresets?.());
    updateMatches();
  }

  function updateMatches() {
    const currentId = String(options.getActivePresetId?.() || "");
    matches = rankModelPresetOptions(entries, input.value, {
      activePresetId: currentId,
      presetUsage: options.getPresetUsage?.(),
    });
    activeIndex = matches.length ? 0 : -1;
    render();
  }

  function render() {
    const currentId = String(options.getActivePresetId?.() || "");
    const fragment = document.createDocumentFragment();
    matches.forEach((entry, index) => {
      const item = document.createElement("button");
      item.id = `model-preset-switcher-option-${index}`;
      item.type = "button";
      item.className = "qz-menu-item model-preset-switcher-item";
      item.dataset.modelPresetIndex = String(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === activeIndex));
      item.disabled = applying;

      const copy = document.createElement("span");
      copy.className = "model-preset-switcher-copy";
      const title = document.createElement("span");
      title.className = "model-preset-switcher-name";
      title.textContent = entry.model || entry.label;
      const meta = document.createElement("span");
      meta.className = "model-preset-switcher-meta";
      meta.textContent = formatPresetMeta(entry);
      copy.append(title, meta);
      item.append(copy);

      if (entry.id === currentId) {
        const current = document.createElement("span");
        current.className = "model-preset-switcher-current";
        current.textContent = t("current");
        item.append(current);
      }
      fragment.append(item);
    });
    list.replaceChildren(fragment);
    list.classList.toggle("is-empty", matches.length === 0);
    dialog.setAttribute("aria-busy", String(applying));
    input.setAttribute("aria-expanded", String(matches.length > 0));
    renderSelection();
    renderStatus();
  }

  function renderSelection() {
    list.querySelectorAll("[data-model-preset-index]").forEach((item, index) => {
      item.setAttribute("aria-selected", String(index === activeIndex));
    });
    const active = activeIndex >= 0
      ? list.querySelector(`[data-model-preset-index="${activeIndex}"]`)
      : null;
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function renderStatus() {
    if (applying) {
      status.textContent = t("switching");
      status.dataset.tone = "muted";
      return;
    }
    if (errorMessage) {
      status.textContent = errorMessage;
      status.dataset.tone = "error";
      return;
    }
    if (loading) {
      status.textContent = t("loadingModelPresets");
      status.dataset.tone = "muted";
      return;
    }
    if (!entries.length) {
      status.textContent = t("noModelPresetsYetSaveAModelConfigurationInSettings");
      status.dataset.tone = "muted";
      return;
    }
    status.textContent = matches.length ? "" : t("noMatchingModelPresets");
    status.dataset.tone = "muted";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (composing || event.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (applying || !matches.length) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") activeIndex = 0;
      else if (event.key === "End") activeIndex = matches.length - 1;
      else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        activeIndex = (activeIndex + direction + matches.length) % matches.length;
      }
      renderSelection();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void applyActive();
    }
  }

  async function applyActive() {
    const entry = matches[activeIndex];
    if (!entry || applying) return false;
    if (entry.id === String(options.getActivePresetId?.() || "")) {
      close();
      return true;
    }
    applying = true;
    errorMessage = "";
    render();
    try {
      await options.applyPreset?.(entry.id);
      close();
      return true;
    } catch (error) {
      applying = false;
      errorMessage = error instanceof Error ? error.message : t("couldNotSwitchModelsPleaseTryAgain");
      if (dialog.open) {
        render();
        requestInputFocus();
      }
      return false;
    }
  }

  return Object.freeze({ open, close, closeIfOpen, refresh, setError, isOpen });
}

export function rankModelPresetOptions(presets: PresetInput[] = [], query = "", options: RankOptions = {}) {
  const entries = normalizePresetEntries(presets);
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!tokens.length) {
    return rankPresetEntriesByUsage(entries, options);
  }
  return entries
    .map((entry, index) => ({ entry, index, score: scorePreset(entry, tokens) }))
    .filter(item => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(item => item.entry);
}

function rankPresetEntriesByUsage(entries: PresetEntry[], options: RankOptions) {
  if (entries.length < 2) return entries;
  const activePresetId = String(options?.activePresetId || "");
  const usage = options?.presetUsage;
  const selections = isRecord(usage?.selections) ? usage.selections : {};
  const transitions = isRecord(usage?.transitions?.[activePresetId])
    ? usage.transitions[activePresetId]
    : {};

  return entries
    .map((entry, index) => ({
      entry,
      index,
      current: entry.id === activePresetId,
      transitionCount: normalizeUsageCount(transitions[entry.id]),
      selectionCount: normalizeUsageCount(selections[entry.id]),
    }))
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? 1 : -1;
      const leftHasTransition = left.transitionCount > 0;
      const rightHasTransition = right.transitionCount > 0;
      if (leftHasTransition !== rightHasTransition) return leftHasTransition ? -1 : 1;
      if (leftHasTransition && left.transitionCount !== right.transitionCount) {
        return right.transitionCount - left.transitionCount;
      }
      if (left.selectionCount !== right.selectionCount) {
        return right.selectionCount - left.selectionCount;
      }
      return left.index - right.index;
    })
    .map(item => item.entry);
}

function normalizePresetEntries(presets: PresetInput[] | undefined) {
  return (Array.isArray(presets) ? presets : [])
    .map((preset) => ({
      id: String(preset?.id || "").trim(),
      name: String(preset?.name || "").trim(),
      label: String(preset?.label || preset?.name || preset?.model || t("untitledPreset")).trim(),
      provider: String(preset?.provider || "").trim(),
      providerLabel: String(preset?.providerLabel || preset?.provider || "").trim(),
      model: String(preset?.model || "").trim(),
    }))
    .filter(preset => preset.id);
}

function formatPresetMeta(entry: PresetEntry) {
  const parts = [entry.providerLabel];
  const name = String(entry.name || "").trim();
  const normalizedName = normalizeSearchText(name);
  const normalizedModel = normalizeSearchText(entry.model);
  const repeatsProvider = normalizedName === normalizeSearchText(entry.providerLabel);
  const includesModel = normalizedModel && normalizedName.includes(normalizedModel);
  if (name && !repeatsProvider && !includesModel) parts.push(name);
  return parts.filter(Boolean).join(" · ");
}

function scorePreset(entry: PresetEntry, tokens: string[]) {
  const text = normalizeSearchText([
    entry.label,
    entry.providerLabel,
    entry.provider,
    entry.model,
  ].join(" "));
  const compact = text.replace(/\s+/g, "");
  let total = 0;
  for (const token of tokens) {
    const score = scoreToken(text, compact, token);
    if (!Number.isFinite(score)) return Number.POSITIVE_INFINITY;
    total += score;
  }
  return total;
}

function scoreToken(text: string, compactText: string, token: string) {
  const directIndex = text.indexOf(token);
  if (directIndex >= 0) return directIndex === 0 ? -20 : directIndex;
  const compactToken = token.replace(/\s+/g, "");
  const compactIndex = compactText.indexOf(compactToken);
  if (compactIndex >= 0) return 20 + compactIndex;
  let cursor = -1;
  let gaps = 0;
  let start = -1;
  for (const character of compactToken) {
    const next = compactText.indexOf(character, cursor + 1);
    if (next < 0) return Number.POSITIVE_INFINITY;
    if (start < 0) start = next;
    if (cursor >= 0) gaps += next - cursor - 1;
    cursor = next;
  }
  return 80 + start + gaps * 3;
}

function normalizeSearchText(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeUsageCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
