import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import { updateDataRow, type DataRow } from "#sdk/shared/data";
import { escapeHtml, copyPlainText } from "#sdk/sidepanel/dom";

type DetailRow = { field: string; value: string };
interface DataGridEditorOptions {
  signal?: AbortSignal;
  root?: Document | HTMLElement;
  panel: HTMLElement | null;
  titleEl: HTMLElement | null;
  metaEl: HTMLElement | null;
  tableEl: HTMLElement | null;
  primaryButton: HTMLButtonElement | null;
  getRows(): DataRow[];
  getCurrentTable(): string | null;
  getColumns(): string[];
  hiddenColumns: Set<string>;
  dataFieldValue(row: DataRow, field: string): unknown;
  isEditableColumn(field: string): boolean;
  normalizeOpenableLinkUrl(value: string): string;
  parseEditedValue(value: string, field: string, previous: unknown): unknown;
  valuesEqual(a: unknown, b: unknown): boolean;
  setEditStatus(message: string, state?: string, options?: { timeout?: number }): void;
  replaceCurrentRow(row: DataRow | null): void;
  updateGridRow?(id: string, row: DataRow | null): void;
  pulseSavedCell(id: string, field: string): void;
  refreshTablesQuietly(): void;
}

export function createDataGridEditors(options: DataGridEditorOptions) {
  const lifecycleSignal = options.signal;
  const root = options.root || document;
  const panel = options.panel;
  const titleEl = options.titleEl;
  const metaEl = options.metaEl;
  const tableEl = options.tableEl;
  const primaryButton = options.primaryButton;
  let currentEditor: { rowId: string; field: string; originalValue: unknown } | null = null;
  let detailRows: DetailRow[] = [];
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  root.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || panel?.classList.contains("hidden")) return;
    close();
  }, { signal: lifecycleSignal });

  function openCell(rowId: string, field: string) {
    const record = options.getRows?.().find(item => item.id === rowId);
    if (!record || !field || !panel || !tableEl) return;
    const oldValue = options.dataFieldValue(record, field);
    const editable = options.isEditableColumn(field);
    currentEditor = { rowId, field, originalValue: cloneValue(oldValue) };
    detailRows = [];
    panel.classList.remove("hidden");
    panel.classList.add("cell-editor");
    if (titleEl) titleEl.textContent = t("cellContent");
    if (metaEl) metaEl.textContent = `${options.getCurrentTable?.() || ""} · ${field}`;
    tableEl.innerHTML = renderCellEditor(field, oldValue, { editable });
    resetCopyButton(editable ? t("save") : t("copy"), editable ? t("saveContent") : t("copyContent"));
    requestAnimationFrame(() => {
      const input = tableEl.querySelector<HTMLTextAreaElement>("[data-data-cell-detail-input]");
      input?.focus?.({ preventScroll: true });
      placeCaretAtEnd(input);
    });
  }

  function openRow(rowId: string) {
    const record = options.getRows?.().find(item => item.id === rowId);
    if (!record || !panel || !tableEl) return;
    currentEditor = null;
    detailRows = buildRowDetailRows(record);
    panel.classList.remove("hidden");
    panel.classList.remove("cell-editor");
    if (titleEl) titleEl.textContent = t("rowDetails");
    if (metaEl) metaEl.textContent = `${options.getCurrentTable?.() || ""} · ${record.id}`;
    tableEl.innerHTML = renderRowDetailTable(detailRows);
    resetCopyButton(t("copy"), t("copyAsTable"));
  }

  function close() {
    panel?.classList.add("hidden");
    panel?.classList.remove("cell-editor");
    detailRows = [];
    currentEditor = null;
    if (tableEl) tableEl.innerHTML = "";
    resetCopyButton(t("copy"), t("copyAsTable"));
  }

  function closeCell() {
    if (currentEditor) close();
  }

  function renderCellEditor(field: string, value: unknown, { editable = true } = {}) {
    const readonly = editable ? "" : " readonly";
    return `
      <div class="data-cell-detail-editor">
        <textarea data-data-cell-detail-input class="qz-field qz-field--mono data-cell-detail-input"
          spellcheck="false" data-field="${escapeHtmlAttribute(field)}" ${readonly}
        >${escapeHtml(formatDetailValue(value))}</textarea>
      </div>
    `;
  }

  function buildRowDetailRows(record: DataRow) {
    const rows: DetailRow[] = [];
    const add = (field: string, value: unknown) => rows.push({ field, value: formatDetailValue(value) });
    add("_rowId", record.id);
    add("table", record.table || options.getCurrentTable?.() || "");
    if (record.createdAt) add("createdAt", record.createdAt);
    if (record.updatedAt) add("updatedAt", record.updatedAt);
    const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : null;
    if (!data) {
      add("data", record.data);
      return rows;
    }
    const orderedFields: string[] = [];
    for (const column of options.getColumns?.() || []) {
      if (options.hiddenColumns?.has(column) || column === "table") continue;
      if (Object.prototype.hasOwnProperty.call(data, column)) orderedFields.push(column);
    }
    for (const column of Object.keys(data)) {
      if (!orderedFields.includes(column)) orderedFields.push(column);
    }
    orderedFields.forEach(field => add(field, data[field]));
    return rows;
  }

  function renderRowDetailTable(rows: DetailRow[]) {
    if (!rows.length) return `<div class="data-row-detail-empty">${escapeHtml(t("noContent"))}</div>`;
    return `
      <table class="data-row-detail-table">
        <thead><tr><th>${escapeHtml(t("columns"))}</th><th>${escapeHtml(t("value"))}</th></tr></thead>
        <tbody>${rows.map(row => `
          <tr>
            <td class="data-row-detail-key" title="${escapeHtmlAttribute(row.field)}">${escapeHtml(row.field)}</td>
            <td class="data-row-detail-value">${renderDetailValue(row.value)}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    `;
  }

  function renderDetailValue(value: unknown) {
    const text = String(value ?? "");
    const pattern = /https?:\/\/[^\s<>"'`]+/gi;
    const parts = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const rawUrl = match[0];
      const url = trimDetailUrl(rawUrl);
      const index = match.index || 0;
      const normalized = options.normalizeOpenableLinkUrl(url);
      if (!normalized) continue;
      if (index > cursor) parts.push(escapeHtml(text.slice(cursor, index)));
      parts.push(`<a class="data-row-detail-link" href="${escapeHtmlAttribute(normalized)}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttribute(normalized)}">${escapeHtml(url)}</a>`);
      cursor = index + url.length;
    }
    if (!parts.length) return escapeHtml(text);
    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
    return parts.join("");
  }

  async function handlePrimaryAction() {
    if (currentEditor) return save();
    return copy();
  }

  async function save() {
    const editor = currentEditor;
    const input = tableEl?.querySelector<HTMLTextAreaElement>("[data-data-cell-detail-input]");
    if (!editor || !input) return;
    const { rowId, field, originalValue } = editor;
    if (!options.isEditableColumn(field)) {
      await copyPlainText(input.value || "");
      setCopyButton(t("copied"), "success", t("copy"), t("copyContent"));
      return;
    }
    let nextValue;
    try {
      nextValue = options.parseEditedValue(input.value, field, originalValue);
    } catch (error) {
      options.setEditStatus(error instanceof Error ? error.message : t("invalidValueFormat"), "error");
      return;
    }
    if (options.valuesEqual(nextValue, originalValue)) {
      close();
      options.setEditStatus(t("noChanges"), "saved");
      return;
    }
    options.setEditStatus("", "", { timeout: 0 });
    try {
      const updated = await updateDataRow(rowId, { [field]: nextValue }, {
        expectedData: { [field]: originalValue },
      });
      options.replaceCurrentRow(updated);
      options.updateGridRow?.(rowId, updated);
      options.pulseSavedCell(rowId, field);
      close();
      options.setEditStatus(t("saved"), "saved");
      options.refreshTablesQuietly();
    } catch (error) {
      options.setEditStatus(error instanceof Error ? error.message : t("couldNotSave"), "error");
    }
  }

  async function copy() {
    if (currentEditor) {
      const input = tableEl?.querySelector<HTMLTextAreaElement>("[data-data-cell-detail-input]");
      if (!input) return;
      await copyPlainText(input.value || "");
      setCopyButton(t("copied"), "success");
      return;
    }
    if (!detailRows.length) return;
    const text = [[t("columns"), t("value")], ...detailRows.map(row => [row.field, row.value])]
      .map(row => row.map(formatTsvCell).join("\t"))
      .join("\n");
    try {
      await copyPlainText(text);
      setCopyButton(t("copied"), "success");
    } catch (error) {
      console.warn("[轻舟数据] row detail copy failed", error);
      setCopyButton(t("failed"), "error");
    }
  }

  function setCopyButton(label: string, state = "", resetLabel = t("copy"), resetTitle = t("copyAsTable")) {
    if (!primaryButton) return;
    const labelEl = primaryButton.querySelector("span");
    if (labelEl) labelEl.textContent = label;
    primaryButton.classList.toggle("success", state === "success");
    primaryButton.classList.toggle("error", state === "error");
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => resetCopyButton(resetLabel, resetTitle), 1200);
  }

  function resetCopyButton(label = t("copy"), title = t("copyAsTable")) {
    if (!primaryButton) return;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = null;
    primaryButton.title = title;
    const labelEl = primaryButton.querySelector("span");
    if (labelEl) labelEl.textContent = label;
    primaryButton.classList.remove("success", "error");
  }

  return {
    openCell,
    openRow,
    close,
    closeCell,
    handlePrimaryAction,
    save,
    copy,
    hasCellEditor: () => Boolean(currentEditor),
  };
}

function placeCaretAtEnd(input: HTMLTextAreaElement | null) {
  if (!input || typeof input.setSelectionRange !== "function") return;
  const end = String(input.value || "").length;
  try { input.setSelectionRange(end, end); } catch (_error) {}
}

function cloneValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return value; }
}

function formatDetailValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "object") {
    try { return JSON.stringify(value, null, 2); } catch (_error) { return String(value); }
  }
  return String(value);
}

function trimDetailUrl(rawUrl: string) {
  let url = String(rawUrl || "");
  while (/[),.;!?，。；、）】》]+$/.test(url)) url = url.slice(0, -1);
  return url;
}

function formatTsvCell(value: unknown) {
  const text = String(value ?? "");
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
