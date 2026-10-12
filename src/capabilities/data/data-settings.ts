import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import type { ToolView } from "#sdk/sidepanel";
import type { createDataTableRenderer } from "#sdk/sidepanel/components";

type Data = Record<string, unknown>;
type TableRenderer = ReturnType<typeof createDataTableRenderer>["appendRowsTable"];
type TableOptions = NonNullable<Parameters<TableRenderer>[3]>;

import { escapeHtml } from "#sdk/sidepanel/dom";

export function createDataProfiles(appendDataRowsTable: TableRenderer) {
function appendPreparingDataProfile(parent: HTMLElement, tool: ToolView, status: ToolView["status"]) {
  const args = tool.args && typeof tool.args === "object" ? tool.args : {};
  const records = collectDataRowsForDisplay(args, null, { preferArgs: true });
  presentation.appendCompactLine(parent, {
    title: `${status.title} · ${presentation.fieldLabel(args.action || "data_store")}`,
    subtitle: args.table ? t("table", { name: String(args.table) }) : t("dataTableName"),
    meta: [
      records.length ? t("parsedRows", { count: String(records.length) }) : t("preparingToolArguments"),
      args.dedupField ? t("deduplicated", { count: String(args.dedupField) }) : "",
      tool.rawArgsText ? t("characters", { count: String(tool.rawArgsText.length) }) : "",
    ].filter(Boolean),
  });
  presentation.appendCompactParams(parent, tool.name, presentation.pickReadableFields(args, ["rows", "row", "data", "filter"]));
  if (records.length) appendStoreRowsTable(parent, t("parsedData"), records, { streaming: true });
  return true;
}

function appendDataProfile(parent: HTMLElement, args: Data, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = record(value);
  const records = collectDataRowsForDisplay(args, result, { preferArgs: isDataWriteAction(args) });
  appendDataSummary(parent, args, result, records);
  if (records.length) {
    appendStoreRowsTable(parent, dataRowsTitle(args, result), records);
    return true;
  }
  if (Array.isArray(result.tables) && result.tables.length) {
    presentation.appendSlimList(parent, t("dataTable"), result.tables, (value: unknown) => {
      const item = record(value);
      return {
      title: item?.name || item?.table || presentation.summarizeValue(item, 100),
      subtitle: item?.updatedAt || "",
      meta: [item?.rowCount != null ? t("rowCount", { count: String(item.rowCount) }) : "", item?.createdAt].filter(Boolean),
      };
    });
    return true;
  }
  if (Array.isArray(result.columns) && result.columns.length) {
    presentation.appendCompactLine(parent, {
      title: result.table || args.table || t("columns"),
      subtitle: result.columns.map((column: unknown) => record(column).name || column).join(" / "),
      meta: [t("columnCount", { count: String(result.columns.length) })],
    });
  }
  return true;
}

const DATA_STORE_HIDDEN_COLUMNS = ["createdAt", "updatedAt", "_sourceFile", "_sourceSheet"];

function appendDataSummary(parent: HTMLElement, args: Data = {}, result: Data = {}, records: Data[] = []) {
  const stats = [
    [t("tableFieldLabel"), result.table || args.table],
    [t("action"), args.action ? presentation.fieldLabel(args.action) : ""],
    [t("add"), result.inserted],
    [t("update"), result.updated],
    [t("delete"), result.deleted],
    [t("matchedFieldLabel"), result.totalMatched],
    [t("totalRows"), result.totalRows],
    [t("shownThisTime"), records.length || ""],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!stats.length && !result.note) return;
  appendHtmlSection(parent, "tool-data-summary", `
    <div class="tool-data-summary-grid">
      ${stats.map(([label, value]) => `
        <span class="tool-data-summary-item">
          <b>${escapeHtml(presentation.summarizeValue(value, 40))}</b>
          <em>${escapeHtml(label)}</em>
        </span>
      `).join("")}
    </div>
    ${result.note ? `<div class="tool-data-note">${escapeHtml(presentation.summarizeValue(result.note, 180))}</div>` : ""}
  `);
}

function dataRowsTitle(args: Data = {}, result: Data = {}) {
  const action = String(args.action || "").trim();
  if (action === "insert" || action === "upsert") return t("writtenThisTime");
  if (action === "update" || action === "replace") return t("updateResult");
  if (action === "list") return t("queryResult");
  if (result.rowsSample || result.sample) return t("sample");
  return t("data");
}

function isDataWriteAction(args: Data = {}) {
  return ["insert", "upsert", "update", "replace"].includes(String(args.action || "").trim());
}

function collectDataRowsForDisplay(args: Data = {}, result: unknown = null, { preferArgs = false } = {}) {
  const argRows = dataRowsFromArgs(args);
  const resultRows = dataRowsFromResult(result);
  if (preferArgs && argRows.length) return argRows;
  return resultRows.length ? resultRows : argRows;
}

function dataRowsFromArgs(args: Data = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  if (Array.isArray(args.rows)) return normalizeDataRowsForTable(args.rows);
  if (args.row && typeof args.row === "object") return normalizeDataRowsForTable([args.row]);
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return normalizeDataRowsForTable([args.data]);
  return [];
}

function dataRowsFromResult(value: unknown) {
  const result = record(value);
  if (Array.isArray(result.rows)) return normalizeDataRowsForTable(result.rows);
  if (Array.isArray(result.records)) return normalizeDataRowsForTable(result.records);
  if (Array.isArray(result.rowsSample)) return normalizeDataRowsForTable(result.rowsSample);
  if (Array.isArray(result.sample)) return normalizeDataRowsForTable(result.sample);
  if (result.row) return normalizeDataRowsForTable([result.row]);
  if (result.record) return normalizeDataRowsForTable([result.record]);
  if (result.updated) return normalizeDataRowsForTable([result.updated]);
  if (result.created) return normalizeDataRowsForTable([result.created]);
  return [];
}

function normalizeDataRowsForTable(rows: unknown) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeDataRowForTable)
    .filter((row): row is Data => row !== null && Object.keys(row).length > 0);
}

function normalizeDataRowForTable(value: unknown): Data | null {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const item = record(value);
    if (item.data && typeof item.data === "object" && !Array.isArray(item.data)) return { ...record(item.data) };
    if (item.record && typeof item.record === "object" && !Array.isArray(item.record)) return normalizeDataRowForTable(item.record);
    return { ...item };
  }
  return { value };
}

function appendStoreRowsTable(parent: HTMLElement, title: string, records: unknown[], options: TableOptions = {}) {
  const excluded = Array.isArray(options.excludeColumns) ? options.excludeColumns : [];
  return appendDataRowsTable(parent, title, records, {
    ...options,
    excludeColumns: [...DATA_STORE_HIDDEN_COLUMNS, ...excluded],
  });
}

  return { renderData: appendDataProfile, renderPreparingData: appendPreparingDataProfile, collectRows: collectDataRowsForDisplay, rowsFromResult: dataRowsFromResult, appendStoreRowsTable: appendStoreRowsTable };
}
