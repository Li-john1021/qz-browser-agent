import { t, tHtml } from "../../i18n/index.js";
import {
  copyPlainText,
  escapeHtml,
  escapeHtmlAttribute,
  rowsToTsv,
} from "../../ui/ui-utils.js";

import { createToolView, isStaticRendererProjection, planRenderer, RendererRegistry, morphRendererChildren, readableFallback } from "../renderer-host.js";
import type { RendererDefinition, RendererContext, ToolView } from "../renderer-host.js";

type Row = Record<string, unknown>;
interface TableOptions { streaming?: boolean; truncated?: boolean; excludeColumns?: readonly string[]; totalRows?: unknown }
interface TableData extends TableOptions { title: string; rows: Row[] }
type Summarize = (value: unknown, limit?: number) => string;

const DATA_TABLE_ROW_PREVIEW_LIMIT = 200;
const DATA_TABLE_COLUMN_PREVIEW_LIMIT = 48;

/**
 * Generic structured-table primitive. Product-specific column policy belongs
 * to the caller and is expressed through excludeColumns.
 */
export function createDataTableRenderer({ summarizeValue }: { summarizeValue: Summarize }) {
  function normalizeRows(rows: unknown): Row[] {
    return (Array.isArray(rows) ? rows : [])
      .map(normalizeRow)
      .filter((row): row is Row => row !== null && Object.keys(row).length > 0);
  }

  function normalizeRow(item: unknown): Row | null {
    if (item == null) return null;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return { ...item as Row };
    }
    return { value: item };
  }

  function buildTable(document: Document, { title, rows: records, ...options }: TableData, interactive: boolean) {
    const { streaming = false, truncated = false } = options;
    const rows = normalizeRows(records);
    if (!rows.length) return document.createElement("div");
    const allColumns = inferColumns(rows, options.excludeColumns);
    const columns = allColumns.slice(0, DATA_TABLE_COLUMN_PREVIEW_LIMIT);
    const visibleRows = rows.slice(0, DATA_TABLE_ROW_PREVIEW_LIMIT);
    const omittedRows = Math.max(0, rows.length - visibleRows.length);
    const omittedColumns = Math.max(0, allColumns.length - columns.length);
    const totalRows = normalizeTotalRows(options.totalRows);
    const rowMeta = totalRows == null ? t("rowCount", { count: rows.length }) : t("rowsShown", { shown: rows.length, total: totalRows });
    const rowMetaTitle = totalRows == null ? t("rowCount", { count: rows.length }) : t("rowsReturned", { count: rows.length, total: totalRows });
    const section = document.createElement("div");
    section.className = `tool-data-table-section${streaming ? " tool-data-table-streaming" : ""}`;
    section.innerHTML = `
      <div class="tool-data-table-head">
        <div class="tool-data-table-title">${escapeHtml(title || t("data"))}</div>
        <div class="tool-data-table-head-right">
          <div class="tool-data-table-meta">
            <span title="${escapeHtmlAttribute(rowMetaTitle)}">${escapeHtml(rowMeta)}</span>
            <span>${tHtml("columnCount", { count: allColumns.length })}</span>
            ${truncated ? `<span class="tool-data-table-truncated">${tHtml("truncated")}</span>` : ""}
            ${omittedRows ? `<span>${tHtml("firstRows", { count: visibleRows.length })}</span>` : ""}
            ${omittedColumns ? `<span>${tHtml("firstColumns", { count: columns.length })}</span>` : ""}
          </div>
          <button class="qz-btn qz-btn--secondary qz-btn--sm tool-data-table-copy" type="button" title="${tHtml("copyTsvHint")}" aria-label="${tHtml("copyTableTsv")}">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="10" height="12" rx="2"/><path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>${tHtml("copyTsv")}</span>
          </button>
        </div>
      </div>
      <div class="tool-data-table-wrap" data-tool-scroll-surface="table" data-tool-stream-surface="10">
        <table class="tool-data-table">
          <thead>
            <tr>
              <th class="tool-data-row-index">#</th>
              ${columns.map(column => `<th title="${escapeHtmlAttribute(column)}">${escapeHtml(column)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${visibleRows.map((row, index) => `
              <tr>
                <td class="tool-data-row-index">${index + 1}</td>
                ${columns.map(column => renderCell(row[column])).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
    if (!interactive) section.querySelector(".tool-data-table-copy")?.remove();
    return section;
  }

  function tableData(view: ToolView): TableData {
    const result = view.result && typeof view.result === "object" && !Array.isArray(view.result) ? view.result as Record<string, unknown> : {};
    return { title: String(result.title || view.title || t("data")), rows: normalizeRows(Array.isArray(view.result) ? view.result : result.rows || result.records || view.args.rows), streaming: view.isRunning, truncated: result.truncated === true, totalRows: result.totalRows, excludeColumns: Array.isArray(result.excludeColumns) ? result.excludeColumns.filter((v): v is string => typeof v === "string") : [] };
  }

  const definition: RendererDefinition = {
    id: "table",
    lane: "wide",
    renderStatic(view, { document }) { return tableProjection(view, document, false); },
    mount(container, view, { signal, document }: RendererContext) {
      let current = tableData(view);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = (next: ToolView): undefined => {
        current = tableData(next);
        const projection = document.createElement("div");
        projection.append(tableProjection(next, document, true));
        morphRendererChildren(container, projection);
      };
      update(view);
      const handleCopy = async (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".tool-data-table-copy") : null;
        if (!target || !container.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        let label = t("copied");
        let state = "is-confirmed";
        try { await copyPlainText(rowsToTsv(current.rows, inferColumns(current.rows, current.excludeColumns))); }
        catch { label = t("copyFailed"); state = "is-error"; }
        if (signal.aborted || !container.contains(target)) return;
        const text = target.querySelector("span");
        if (text) text.textContent = label;
        target.classList.remove("is-error", "is-confirmed");
        target.classList.add(state);
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (text) text.textContent = t("copyTsv");
          target.classList.remove("is-error", "is-confirmed");
        }, 1400);
      };
      container.addEventListener("click", handleCopy, { signal });
      return { update, dispose() { clearTimeout(timer); } };
    },
  };
  const registry = new RendererRegistry(definition);

  function tableProjection(view: ToolView, document: Document, interactive: boolean): HTMLElement {
    const data = tableData(view);
    return !data.rows.length || view.state === "error" || view.state === "aborted"
      ? readableFallback(view, document)
      : buildTable(document, data, interactive);
  }

  function appendRowsTable(parent: HTMLElement, title: string, records: unknown, options: TableOptions = {}): boolean {
    const rows = normalizeRows(records);
    if (!rows.length) return false;
    const section = parent.ownerDocument.createElement("div");
    // The lifecycle host has no layout box, but remains a DOM sibling for skin selectors.
    section.className = "tool-data-table-host";
    section.style.display = "contents";
    planRenderer(section, registry, createToolView({ id: "table", rendererId: "table", title, isRunning: options.streaming, result: { ...options, title, rows } }), isStaticRendererProjection());
    parent.appendChild(section);
    return true;
  }

  function inferColumns(rows: readonly Row[], excluded: readonly string[] = []): string[] {
    const ordered: string[] = [];
    const seen = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row || {})) {
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(key);
      }
    }
    const excludedSet = new Set(Array.isArray(excluded) ? excluded : []);
    const visible = ordered.filter(key => !excludedSet.has(key));
    return visible.length ? visible : ordered;
  }

  function renderCell(value: unknown): string {
    const title = summarizeValue(value, 1200);
    const text = summarizeValue(value, 180);
    const empty = value === undefined || value === null || value === "";
    if (empty) return '<td class="tool-data-empty-cell"></td>';
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      const url = value.trim();
      return `<td title="${escapeHtmlAttribute(title)}"><a href="${escapeHtmlAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a></td>`;
    }
    return `<td title="${escapeHtmlAttribute(title)}">${escapeHtml(text)}</td>`;
  }

  return {
    definition,
    appendRowsTable,
    escapeAttr: escapeHtmlAttribute,
    inferColumns,
    normalizeRows,
    renderCell,
  };
}

function normalizeTotalRows(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : null;
}
