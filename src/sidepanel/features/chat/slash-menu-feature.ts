import { getLocale } from "../../../shared/i18n/index.js";
import { t, tHtml } from "../../i18n/index.js";
import type { UiReferenceItem as SlashItem, WorkspaceExtensions } from "../app/workspace-extensions.js";
interface SlashOptions {
  input: HTMLTextAreaElement; menu: HTMLElement;
  references?: Pick<WorkspaceExtensions, "referenceSources" | "listReferences">;
  onInputChanged?(): void; onCommand?(command: NonNullable<ReturnType<typeof parseSlashCommandText>>): Promise<unknown>;
}

import { escapeHtml, escapeHtmlAttribute } from "../../ui/ui-utils.js";

const SLASH_MENU_LIMIT = 12;

export const BUILTIN_SLASH_COMMANDS = Object.freeze([
  Object.freeze({
    kind: "command",
    name: "compact_context",
    aliases: Object.freeze(["compact", t("compactContext")]),
    token: "/compact",
    label: t("compactContext"),
    title: t("compactContext"),
    subtitle: t("compactHint"),
    meta: "/compact",
    priority: -1,
    search: "compact 压缩上下文 上下文 摘要 命令",
  }),
]);

export function parseSlashCommandText(value: unknown = "") {
  const source = String(value || "").trim();
  const match = source.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  const alias = String(match[1] || "").toLowerCase();
  const command = BUILTIN_SLASH_COMMANDS.find(item => item.aliases.some(value => value.toLowerCase() === alias));
  if (!command) return null;
  return {
    ...command,
    alias: match[1],
    argumentText: String(match[2] || "").trim(),
  };
}

export function createSlashMenuFeature(options: SlashOptions) {
  const input = options.input;
  const menu = options.menu;
  const referenceSources = () => options.references?.referenceSources() || [];
  const sources = () => [...referenceSources(), {
    id: "command", label: t("commands"), menuLabel: t("commands"), filterLabel: "command", className: "command", emptyText: t("noMatchingCommands"),
  }];
  const onInputChanged = options.onInputChanged || (() => {});
  const onCommand = options.onCommand || (async () => ({}));
  if (!input || !menu) throw new Error("slash menu input and menu are required");

  let slashMenuState = createClosedMenuState();
  let slashResourcesSeq = 0;

function handleSlashMenuKeydown(event: KeyboardEvent) {
  if (!slashMenuState.open) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const count = slashMenuState.items.length;
    if (count > 0) {
      slashMenuState.selected = (slashMenuState.selected + delta + count) % count;
      renderSlashMenu();
    }
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    if (slashMenuState.items.length === 0) return false;
    event.preventDefault();
    selectSlashItem(slashMenuState.selected);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSlashMenu();
    return true;
  }
  return false;
}

async function updateSlashMenu() {
  const trigger = getSlashTrigger();
  if (!trigger) {
    closeSlashMenu();
    return;
  }
  const seq = ++slashResourcesSeq;
  const resources = await loadSlashResources(trigger.query, { includeCommands: trigger.commandEligible });
  if (seq !== slashResourcesSeq) return;
  const filter = slashMenuState.open ? resolveFilter(slashMenuState.filter) : "all";
  slashMenuState = {
    open: true,
    start: trigger.start,
    end: trigger.end,
    query: trigger.query,
    filter,
    selected: 0,
    allItems: resources,
    items: getVisibleSlashItems(resources, filter),
    commandEligible: trigger.commandEligible,
  };
  renderSlashMenu();
}

function getSlashTrigger() {
  const cursor = input.selectionStart ?? input.value.length;
  if (cursor !== (input.selectionEnd ?? cursor)) return null;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(^|\s)\/([^\s/\[\]]*)$/u);
  if (!match) return null;
  const start = before.length - match[2].length - 1;
  return {
    start,
    end: cursor,
    query: match[2] || "",
    commandEligible: !input.value.slice(0, start).trim() && !input.value.slice(cursor).trim(),
  };
}

async function loadSlashResources(query = "", { includeCommands = true } = {}): Promise<SlashItem[]> {
  const q = String(query || "").trim().toLowerCase();
  const references = await options.references?.listReferences() || [];
  const commandItems = includeCommands ? BUILTIN_SLASH_COMMANDS : [];
  return [...commandItems, ...references]
    .filter(item => !q || item.search.includes(q))
    .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, getLocale()));
}

async function refreshOpenSlashMenu() {
  if (!slashMenuState.open) return;
  const seq = ++slashResourcesSeq;
  try {
    const resources = await loadSlashResources(slashMenuState.query, {
      includeCommands: slashMenuState.commandEligible,
    });
    if (seq !== slashResourcesSeq || !slashMenuState.open) return;
    const filter = resolveFilter(slashMenuState.filter);
    const items = getVisibleSlashItems(resources, filter);
    slashMenuState = {
      ...slashMenuState,
      allItems: resources,
      filter,
      items,
      selected: items.length ? Math.min(slashMenuState.selected, items.length - 1) : 0,
    };
    renderSlashMenu();
  } catch (err) {
    console.debug("[轻舟] refresh slash resources after registry update failed:", err instanceof Error ? err.message : err);
  }
}

function resolveFilter(filter: string) {
  return sources().some(source => source.id === filter) ? filter : "all";
}

function getVisibleSlashItems(items: SlashItem[] = [], filter = "all") {
  const visibleItems = filter === "all" ? items : items.filter(item => item.kind === filter);
  return visibleItems.slice(0, SLASH_MENU_LIMIT);
}

function getSlashCounts(items: SlashItem[] = []) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  return counts;
}

function renderSlashFilterBar(counts: ReturnType<typeof getSlashCounts>, filter: string) {
  return `
    <div class="slash-filters" role="group" aria-label="${tHtml("filterTypes")}">
      ${sources().map(source => {
        const active = filter === "all" || filter === source.id;
        return `<button class="slash-filter-btn ${active ? "active" : ""}" type="button" data-slash-filter="${escapeHtmlAttribute(source.id)}" aria-pressed="${String(active)}">${escapeHtml(source.filterLabel || source.label)}: ${counts.get(source.id) || 0}</button>`;
      }).join("\n")}
    </div>
  `;
}

function getSlashEmptyText(filter: string) {
  return sources().find(source => source.id === filter)?.emptyText || t("noMatchingResources");
}

function slashKindLabel(item: Pick<SlashItem, "kind">) {
  const source = sources().find(source => source.id === item.kind);
  return source?.menuLabel || source?.label || item.kind;
}

function slashKindClass(item: Pick<SlashItem, "kind">) {
  return sources().find(source => source.id === item.kind)?.className || "";
}

function renderSlashMenu() {
  if (!slashMenuState.open) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
    return;
  }
  menu.classList.remove("hidden");
  const counts = getSlashCounts(slashMenuState.allItems);
  const filterBar = renderSlashFilterBar(counts, slashMenuState.filter || "all");
  if (!slashMenuState.items.length) {
    menu.innerHTML = `${filterBar}<div class="slash-empty">${escapeHtml(getSlashEmptyText(slashMenuState.filter))}</div>`;
    return;
  }
  menu.innerHTML = `${filterBar}${slashMenuState.items.map((item, index) => `
    <button class="qz-menu-item slash-item ${index === slashMenuState.selected ? "active" : ""}" type="button" data-slash-index="${index}">
      <span class="slash-kind ${escapeHtmlAttribute(slashKindClass(item))}">${escapeHtml(slashKindLabel(item))}</span>
      <span class="slash-main">
        <span class="slash-title">${escapeHtml(item.title)}</span>
        ${item.subtitle ? `<span class="slash-subtitle">${escapeHtml(item.subtitle)}</span>` : ""}
      </span>
      <span class="slash-meta">${escapeHtml(item.meta)}</span>
    </button>
  `).join("")}`;
  menu.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function toggleSlashFilter(kind = "") {
  if (!sources().some(source => source.id === kind)) return;
  const nextFilter = slashMenuState.filter === kind ? "all" : kind;
  slashMenuState = {
    ...slashMenuState,
    filter: nextFilter,
    selected: 0,
    items: getVisibleSlashItems(slashMenuState.allItems, nextFilter),
  };
  renderSlashMenu();
  input.focus();
}

function selectSlashItem(index: number) {
  const item = slashMenuState.items[index];
  if (!item) return;
  const token = item.token || (item.kind === "command" ? "" : `[${item.kind}: ${item.name}]`);
  if (!token) {
    closeSlashMenu();
    input.focus();
    return;
  }
  const before = input.value.slice(0, slashMenuState.start);
  const after = input.value.slice(slashMenuState.end);
  const needsSpace = item.kind === "command" || (after && !/^\s/.test(after)) ? " " : "";
  input.value = `${before}${token}${needsSpace}${after}`;
  const cursor = before.length + token.length + needsSpace.length;
  input.setSelectionRange(cursor, cursor);
  closeSlashMenu();
  onInputChanged();
  input.focus();
}

function closeSlashMenu() {
  slashResourcesSeq += 1;
  slashMenuState = createClosedMenuState();
  renderSlashMenu();
}

  menu.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const filterEl = target?.closest<HTMLElement>("[data-slash-filter]");
    if (filterEl) {
      toggleSlashFilter(filterEl.dataset.slashFilter);
      return;
    }
    const itemEl = target?.closest<HTMLElement>("[data-slash-index]");
    if (!itemEl) return;
    selectSlashItem(Number(itemEl.dataset.slashIndex));
  });
  document.addEventListener("click", (event) => {
    if (!slashMenuState.open) return;
    const target = event.target;
    if (target instanceof Node && target !== input && !menu.contains(target)) closeSlashMenu();
  });

  return {
    handleKeydown: handleSlashMenuKeydown,
    update: updateSlashMenu,
    refresh: refreshOpenSlashMenu,
    close: closeSlashMenu,
    isOpen: () => slashMenuState.open,
    parseCommand: parseSlashCommandText,
    executeCommand: (command: NonNullable<ReturnType<typeof parseSlashCommandText>>) => onCommand(command),
  };
}

function createClosedMenuState() {
  return {
    open: false,
    start: -1,
    end: -1,
    query: "",
    filter: "all",
    selected: 0,
    allItems: [] as SlashItem[],
    items: [] as SlashItem[],
    commandEligible: false,
  };
}
