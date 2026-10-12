import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { DataRow } from '#sdk/shared/data';
import type { ToolContext } from '#sdk/background';
import type { GetToolRuntimeDependencies } from '#sdk/background';
type DataToolsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies">;
type CompatibleDataRow = DataRow & { rowId?: string };
import { requireToolFields, throwMissingToolArgs } from "#sdk/background/tools";
import {
  addDataTableColumn,
  deleteDataTableColumn,
  deleteDataRows,
  getDataRow,
  getDataTableColumns,
  insertDataRows,
  listDataTables,
  queryDataRows,
  renameDataTableColumn,
  replaceDataRow,
  setDataTableColumns,
  updateDataRow,
  upsertDataRows,
} from "#sdk/shared/data";

/** Registers the structured Data table family while leaving validation/policy in ToolRuntime. */
export function registerDataTools({
  registerTool,
  ToolExecutionError,
  getToolRuntimeDependencies,
}: DataToolsHost) {
  registerTool({
  name: "data_store",
  get description() { return modelT("dataStore"); },
  get parameters() { return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["tables", "create_table", "list", "get", "insert", "upsert", "update", "replace", "delete", "schema", "add_column", "rename_column", "delete_column"],
          description: modelT("dataAction"),
        },
        table: { type: "string", description: modelT("dataTable") },
        rowId: { type: "string", description: modelT("dataRowId") },
        field: { type: "string", description: modelT("dataField") },
        value: { description: modelT("dataValue") },
        expectedValue: { description: modelT("dataExpectedValue") },
        revision: { type: "number", description: modelT("dataRevision") },
        column: { type: "string", description: modelT("dataColumn") },
        newColumn: { type: "string", description: modelT("dataNewColumn") },
        dedupField: { type: "string", description: modelT("dataDedupField") },
        columns: { type: "array", items: { type: "string" }, description: modelT("dataColumns") },
        filter: { type: "object", description: modelT("dataFilter") },
        limit: { type: "number", description: modelT("dataLimit") },
        offset: { type: "number", description: modelT("dataOffset") },
        row: { type: "object", description: modelT("dataRow") },
        rows: { type: "array", items: { type: "object" }, description: modelT("dataRows") },
        data: { type: "object", description: modelT("dataReplacement") },
      },
      required: ["action"],
    } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async (input, _signal, context = {}) => {
      const { action, table, row, rows, columns, rowId, field, value, column, newColumn, data, revision = null, dedupField = "", filter = {}, limit = 100, offset = 0 } = input;
      if (action === "tables") return { tables: await listDataTables() };

      if (action === "create_table") {
        const tableRecord = await setDataTableColumns(table, columns);
        const nextColumns = await getDataTableColumns(table);
        const totalRows = await getDataTableRowCount(table);
        emitDataChanged({ action, table, totalRows, columns: nextColumns.length }, context, getToolRuntimeDependencies);
        return {
          action,
          table: tableRecord?.name || table,
          columns: nextColumns,
          totalRows,
          note: modelT("tableSchemaCreated"),
        };
      }

      if (action === "insert") {
        const inserted = await insertDataRows(table, rows ?? row, { columns });
        const totalRows = await getDataTableRowCount(table);
        emitDataChanged({ action, table, totalRows, changed: inserted.length }, context, getToolRuntimeDependencies);
        return {
          table,
          inserted: inserted.length,
          totalRows,
          rowIdCount: inserted.length,
          rowIdsSample: inserted.slice(0, 3).map(record => record.id),
          rowsSample: toAgentDataRows(inserted.slice(0, 3)),
          note: rows
            ? t("batchWriteCompletedRowIdsWereAssignedAutomaticallyFor")
            : t("onlyOneRowWasWrittenForCollectionTasksUse"),
        };
      }

      if (action === "upsert") {
        const result = await upsertDataRows(table, rows ?? row, { dedupField, columns });
        const totalRows = await getDataTableRowCount(table);
        emitDataChanged({ action, table, totalRows, inserted: result.inserted, updated: result.updated }, context, getToolRuntimeDependencies);
        return {
          table,
          inserted: result.inserted,
          updated: result.updated,
          totalRows,
          rowIdCount: result.records.length,
          rowIdsSample: result.records.slice(0, 3).map(record => record.id),
          rowsSample: toAgentDataRows(result.records.slice(0, 3)),
          dedupField: dedupField || "",
          note: modelT("upsertCompleted"),
        };
      }

      if (action === "list") {
        const result = await queryDataRows({ table, filter, limit: Math.min(Number(limit) || 100, 1000), offset });
        const filtered = filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length > 0;
        return {
          table: table || null,
          totalMatched: result.totalMatched,
          totalRows: filtered ? await getDataTableRowCount(table) : result.totalMatched,
          limit: result.limit,
          offset: result.offset,
          rows: toAgentDataRows(result.rows),
        };
      }

      if (action === "get") {
        const rowResult = await getDataRow(rowId!);
        if (!rowResult) {
          throw new ToolExecutionError(
            "DATA_ROW_NOT_FOUND",
            t("dataStoreGetCouldNotFindTheRowRead"),
            { action, rowId, recovery: "Call data_store list, then copy the matching rows[].rowId without changing it." },
          );
        }
        return { table: rowResult.table || null, row: toAgentDataRow(rowResult) };
      }

      if (action === "update" || action === "replace") {
        if (action === "update" && !Object.prototype.hasOwnProperty.call(input, "value")) {
          throwMissingToolArgs("data_store", ["value"], input, { action, requiredWhen: "action=update" });
        }
        const updated = action === "update"
          ? await updateDataRow(rowId!, { [field!]: value }, { expectedData: expectedDataForFieldUpdate(input, field) })
          : await replaceDataRow(rowId!, data, { expectedRevision: revision });
        const totalRows = await getDataTableRowCount(updated.table);
        emitDataChanged({ action, table: updated.table, totalRows, changed: 1 }, context, getToolRuntimeDependencies);
        return {
          action,
          table: updated.table,
          [action === "update" ? "updated" : "replaced"]: 1,
          changed: 1,
          totalRows,
          row: toAgentDataRow(updated),
        };
      }

      if (action === "add_column") {
        await addDataTableColumn(table, column);
        const totalRows = await getDataTableRowCount(table);
        const nextColumns = await getDataTableColumns(table);
        emitDataChanged({ action, table, totalRows, column }, context, getToolRuntimeDependencies);
        return { action, table, column, columns: nextColumns, totalRows };
      }

      if (action === "rename_column") {
        const result = await renameDataTableColumn(table, column, newColumn);
        const totalRows = await getDataTableRowCount(table);
        const nextColumns = await getDataTableColumns(table);
        emitDataChanged({ action, table, totalRows, changed: result.changed, column, newColumn }, context, getToolRuntimeDependencies);
        return { action, ...result, columns: nextColumns, totalRows };
      }

      if (action === "delete_column") {
        const result = await deleteDataTableColumn(table, column, { dropData: true });
        const totalRows = await getDataTableRowCount(table);
        const nextColumns = await getDataTableColumns(table);
        emitDataChanged({ action, table, totalRows, changed: result.changed, column }, context, getToolRuntimeDependencies);
        return { action, ...result, columns: nextColumns, totalRows };
      }

      if (String(action) === "clear") {
        throw new ToolExecutionError(
          "DATA_DESTRUCTIVE_ACTION_DISABLED",
          t("dataStoreClearIsDisabledForAgentRunsAsk"),
          { action, table },
        );
      }

      if (action === "delete") {
        if (!rowId) throw new ToolExecutionError("MISSING_DATA_ROW_ID", t("dataStoreDeleteRequiresRowid"), { action, table });
        const result = await deleteDataRows(rowId, { table });
        const deletedRecord = result.records?.[0] || null;
        if (result.skipped?.length) {
          throw new ToolExecutionError(
            "DATA_ROW_TABLE_MISMATCH",
            t("dataStoreDeleteRefusedBecauseTheRowBelongsTo"),
            { action, table, rowId, actualTable: result.skipped[0]?.table || "" },
          );
        }
        if (result.deleted === 0) {
          throw new ToolExecutionError(
            "DATA_ROW_NOT_FOUND",
            t("dataStoreDeleteCouldNotFindTheRowRead"),
            {
              action,
              table,
              rowId,
              notFoundRowIds: result.notFound || [],
              recovery: "Call data_store list, then copy the matching rows[].rowId without changing it.",
            },
          );
        }
        const affectedTable = deletedRecord?.table || table || "";
        const totalRows = affectedTable ? await getDataTableRowCount(affectedTable) : 0;
        if (result.deleted > 0) {
          emitDataChanged({ action, table: affectedTable, totalRows, deleted: result.deleted, rowId }, context, getToolRuntimeDependencies);
        }
        return {
          action,
          table: affectedTable || null,
          rowId,
          deleted: result.deleted,
          totalRows,
          deletedRow: deletedRecord ? compactDeletedDataRecord(deletedRecord) : null,
          notFoundRowIds: result.notFound || [],
          note: modelT("rowDeleted"),
        };
      }

      if (action === "schema") return { table, columns: await getDataTableColumns(table) };
      throw new ToolExecutionError("INVALID_DATA_ACTION", t("unsupportedDataStoreAction", { action: String(action) }), { action });
    },
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["create_table"].includes(action)) requireToolFields("data_store", args, ["table","columns"], { action, requiredWhen: `action=${action}` });
    if (["insert","upsert"].includes(action)) requireToolFields("data_store", args, ["table",["rows","row"]], { action, requiredWhen: `action=${action}` });
    if (["list","schema"].includes(action)) requireToolFields("data_store", args, ["table"], { action, requiredWhen: `action=${action}` });
    if (["get","delete"].includes(action)) requireToolFields("data_store", args, ["rowId"], { action, requiredWhen: `action=${action}` });
    if (["update"].includes(action)) requireToolFields("data_store", args, ["rowId","field"], { action, requiredWhen: `action=${action}` });
    if (["replace"].includes(action)) requireToolFields("data_store", args, ["rowId","revision","data"], { action, requiredWhen: `action=${action}` });
  },
});
}

function expectedDataForFieldUpdate(input: { expectedValue?: unknown } = {}, field = "") {
  const key = String(field || "");
  return {
    [key]: Object.prototype.hasOwnProperty.call(input, "expectedValue") ? input.expectedValue : undefined,
  };
}

async function getDataTableRowCount(table: unknown) {
  if (!table) return 0;
  return (await queryDataRows({ table, limit: 1 })).totalMatched;
}

function toAgentDataRow(record: CompatibleDataRow | null = null) {
  if (!record || typeof record !== "object") return record;
  const { id, rowId, table, ...rest } = record;
  return { rowId: id || rowId || "", ...rest };
}

function toAgentDataRows(records: CompatibleDataRow[] = []) {
  return Array.isArray(records) ? records.map(toAgentDataRow) : [];
}

function compactDeletedDataRecord(record: CompatibleDataRow) {
  if (!record || typeof record !== "object") return null;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
  const keys = Object.keys(data);
  return {
    rowId: record.id || record.rowId || "",
    order: record.order,
    revision: record.revision,
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
    data: keys.length <= 20 ? data : Object.fromEntries(keys.slice(0, 20).map(key => [key, data[key]])),
    truncated: keys.length > 20,
  };
}

function emitDataChanged(payload: Record<string, unknown>, context: ToolContext, getToolRuntimeDependencies: GetToolRuntimeDependencies) {
  const sink = getToolRuntimeDependencies(context).emit;
  try {
    sink?.({ type: "data_changed", ...payload });
  } catch (_error) {
    // UI projection failure must not roll back a durable Data write.
  }
}


export default registerDataTools satisfies ToolExtension;
