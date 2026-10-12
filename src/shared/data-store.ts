import { t } from "./i18n/backend.js";
import { compareBeijingDateTimeDesc, nowBeijingDateTime } from "./time-utils.js";
import { requestToPromise, txDone } from "./indexeddb.js";

export interface DataRow {
  id: string;
  table: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  order?: number;
  revision?: number;
}
export interface DataColumnMeta { width?: number; widthGrow?: number; hidden?: boolean; frozen?: boolean }
export interface DataTable {
  name: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  columns?: string[];
  columnMeta?: Record<string, DataColumnMeta>;
  nextAppendOrder?: number;
  nextPrependOrder?: number;
  [key: string]: unknown;
}
interface RowOrderEntry { record: DataRow; fallbackOrder: number }
interface RowWriteOptions { columns?: unknown; position?: string; dedupField?: unknown }
interface DataQuery { table?: unknown; limit?: unknown; offset?: unknown; filter?: unknown }
interface StoreTrace { at: string; name: string; ms: number; meta: Record<string, unknown> }

const DB_NAME = "qz-browser-agent-data";
const DB_VERSION = 2;
const RECORDS_STORE = "records";
const TABLES_STORE = "tables";
const META_STORE = "meta";
const ROW_ID_COLUMN = "_rowId";
const DATA_ROW_CONFLICT = "DATA_ROW_CONFLICT";
const DATA_STORE_TRACE_BUFFER_LIMIT = 200;
const DATA_ROW_ORDER_STEP = 1000;
const DATA_ROW_ID_PREFIX = "row:";
const DATA_ROW_ID_ALLOCATION_ATTEMPTS = 8;
const RECORD_ID_REPAIR_MARKER = "repair.record_ids.v1";
const ROW_ORDER_REPAIR_MARKER = "repair.row_order.v1";
const TABLE_INDEX_REPAIR_MARKER = "repair.table_index.v1";
let repairReady: Promise<void> | null = null;
let tableIndexRepairReady: Promise<void> | null = null;
let dataStoreWriteQueue: Promise<unknown> = Promise.resolve();

export class DataStoreConflictError extends Error {
  readonly code = DATA_ROW_CONFLICT;
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DataStoreConflictError";
  }
}

export async function listDataTables() {
  const end = startDataStoreTrace("list_tables");
  try {
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    await ensureDataTableIndexRepaired(db);
    const rows = await requestToPromise<DataTable[]>(db.transaction(TABLES_STORE, "readonly").objectStore(TABLES_STORE).getAll());
    end({ tables: rows.length });
    return rows
      .map(row => normalizeTableRecordForRead(row))
      .sort((a, b) => compareBeijingDateTimeDesc(a.updatedAt, b.updatedAt));
  } catch (err) {
    end({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function getDataTableColumns(table: unknown) {
  const name = normalizeTableName(table);
  const db = await openDataDb();
  await ensureDataStoreRepaired(db);
  await ensureDataTableIndexRepaired(db);
  const tableRecord = normalizeTableRecordForRead(await requestToPromise<DataTable | undefined>(
    db.transaction(TABLES_STORE, "readonly").objectStore(TABLES_STORE).get(name),
  ));
  if (tableRecord?.columns?.length) return tableRecord.columns;
  const rows = await readTableRecords(db, name);
  return inferDataColumnsFromRows(rows.map(record => record.data || {}));
}

export async function updateDataTableMetadata(table: unknown, metadata: unknown = {}) {
  const name = normalizeTableName(table);
  const patch = cloneJsonObject(metadata);
  const updated = await updateTableSchema(name, existing => {
    const columns = mergeColumnOrder(existing?.columns, patch.columns);
    const patchHasColumnMeta = Object.prototype.hasOwnProperty.call(patch, "columnMeta");
    const columnMeta = normalizeColumnMeta(patchHasColumnMeta ? patch.columnMeta : existing?.columnMeta, columns);
    return { ...patch, columns, columnMeta };
  });
  return normalizeTableRecordForRead(updated);
}

export async function setDataTableColumns(table: unknown, columns: unknown, { columnMeta = null }: { columnMeta?: unknown } = {}) {
  const name = normalizeTableName(table);
  const nextColumns = normalizeColumnOrder(columns) || [];
  return updateTableSchema(name, existing => ({
    columns: nextColumns,
    columnMeta: normalizeColumnMeta(columnMeta == null ? existing?.columnMeta : columnMeta, nextColumns),
  }));
}

export async function addDataTableColumn(table: unknown, column: unknown, { meta = {} }: { meta?: unknown } = {}) {
  const name = normalizeTableName(table);
  const field = normalizeEditableColumnName(column);
  const nextFieldMeta = normalizeSingleColumnMeta(meta);
  return updateTableSchema(name, existing => {
    const columns = mergeColumnOrder(existing?.columns, [field]);
    const columnMeta = {
      ...normalizeColumnMeta(existing?.columnMeta, columns),
      ...(Object.keys(nextFieldMeta).length ? { [field]: nextFieldMeta } : {}),
    };
    return { columns, columnMeta };
  });
}

/** Serializes metadata-only edits; row migrations keep their wider transactions below. */
function updateTableSchema(name: string, buildPatch: (existing: DataTable | undefined) => Partial<DataTable>) {
  return enqueueDataStoreWrite(async () => {
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const tx = db.transaction(TABLES_STORE, "readwrite");
    const store = tx.objectStore(TABLES_STORE);
    const existing = await requestToPromise<DataTable | undefined>(store.get(name));
    const now = nowBeijingDateTime();
    store.put({
      ...existing,
      ...buildPatch(existing),
      name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      count: Math.max(0, Number(existing?.count || 0)),
    });
    await txDone(tx);
    return requestToPromise<DataTable | undefined>(db.transaction(TABLES_STORE, "readonly").objectStore(TABLES_STORE).get(name));
  });
}

export async function renameDataTableColumn(table: unknown, oldColumn: unknown, newColumn: unknown) {
  const name = normalizeTableName(table);
  const from = normalizeEditableColumnName(oldColumn);
  const to = normalizeEditableColumnName(newColumn);
  if (from === to) return { table: name, oldColumn: from, newColumn: to, changed: 0 };
  return enqueueDataStoreWrite(async () => {
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const rows = await readTableRecords(db, name);
    const conflicts = rows.filter(record => {
      const data = cloneRecordData(record?.data);
      return Object.prototype.hasOwnProperty.call(data, from)
        && Object.prototype.hasOwnProperty.call(data, to);
    });
    if (conflicts.length) {
      throw new Error(t("data.renameConflict", { field: String(to), count: String(conflicts.length) }));
    }

    const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
    const records = tx.objectStore(RECORDS_STORE);
    const tables = tx.objectStore(TABLES_STORE);
    const existing = await requestToPromise<DataTable | undefined>(tables.get(name));
    const now = nowBeijingDateTime();
    let changed = 0;
    for (const record of rows) {
      const data = cloneRecordData(record?.data);
      if (!Object.prototype.hasOwnProperty.call(data, from)) continue;
      data[to] = data[from];
      delete data[from];
      records.put({
        ...record,
        data,
        updatedAt: now,
        revision: nextRecordRevision(record),
      });
      changed += 1;
    }

    const existingColumns = normalizeColumnOrder(existing?.columns) || [];
    const rowColumns = inferDataColumnsFromRows(rows.map(record => record.data || {}));
    const baseColumns = existingColumns.includes(from)
      ? existingColumns
      : rowColumns.includes(from)
        ? mergeColumnOrder(rowColumns, existingColumns)
        : mergeColumnOrder(existingColumns, rowColumns);
    const columns = renameColumnOrder(baseColumns, from, to);
    const columnMeta = renameColumnMeta(existing?.columnMeta, columns, from, to);
    tables.put({
      ...(existing || {}),
      name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      count: Math.max(0, Number(existing?.count || rows.length || 0)),
      columns,
      columnMeta,
    });
    await txDone(tx);
    return { table: name, oldColumn: from, newColumn: to, changed };
  });
}

export async function deleteDataTableColumn(table: unknown, column: unknown, { dropData = false } = {}) {
  const name = normalizeTableName(table);
  const field = normalizeEditableColumnName(column);
  return enqueueDataStoreWrite(async () => {
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const rows = dropData ? await readTableRecords(db, name) : [];
    const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
    const records = tx.objectStore(RECORDS_STORE);
    const tables = tx.objectStore(TABLES_STORE);
    const existing = await requestToPromise<DataTable | undefined>(tables.get(name));
    const now = nowBeijingDateTime();
    let changed = 0;

    if (dropData) {
      for (const record of rows) {
        const data = cloneRecordData(record?.data);
        if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
        delete data[field];
        records.put({
          ...record,
          data,
          updatedAt: now,
          revision: nextRecordRevision(record),
        });
        changed += 1;
      }
    }

    const columns = dropData
      ? (normalizeColumnOrder(existing?.columns) || []).filter(item => item !== field)
      : mergeColumnOrder(existing?.columns, [field]);
    const columnMeta = dropData
      ? normalizeColumnMeta(existing?.columnMeta, columns)
      : {
          ...normalizeColumnMeta(existing?.columnMeta, columns),
          [field]: {
            ...normalizeSingleColumnMeta(existing?.columnMeta?.[field]),
            hidden: true,
          },
        };
    tables.put({
      ...(existing || {}),
      name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      count: Math.max(0, Number(existing?.count || rows.length || 0)),
      columns,
      columnMeta,
    });
    await txDone(tx);
    return { table: name, column: field, changed, dropData: Boolean(dropData) };
  });
}

export async function insertDataRows(table: unknown, rows: unknown, { columns = null, position = "append" }: RowWriteOptions = {}) {
  return enqueueDataStoreWrite(async () => {
    const name = normalizeTableName(table);
    const list = normalizeRows(rows);
    const now = nowBeijingDateTime();
    const columnOrder = normalizeColumnOrder(columns) || inferDataColumnsFromRows(list);
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
    const records = tx.objectStore(RECORDS_STORE);
    const reservedIds = new Set<string>();
    const rowIds = [];
    for (let index = 0; index < list.length; index += 1) {
      rowIds.push(await allocateDataRowId(records, reservedIds));
    }
    const orders = await allocateDataRowOrders(tx, name, list.length, { position, now });

    const inserted = [];
    for (const [index, row] of list.entries()) {
      const record = {
        id: rowIds[index],
        table: name,
        order: orders[index],
        data: cloneJsonObject(row),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      records.add(record);
      inserted.push(record);
    }
    await touchTable(tx, name, { countDelta: inserted.length, now, columns: columnOrder });
    await txDone(tx);
    return inserted;
  });
}

export async function upsertDataRows(table: unknown, rows: unknown, { dedupField = "", columns = null, position = "append" }: RowWriteOptions = {}) {
  return enqueueDataStoreWrite(async () => {
    const name = normalizeTableName(table);
    const normalizedDedupField = normalizeDedupField(dedupField);
    const list = normalizeRows(rows);
    const columnOrder = normalizeColumnOrder(columns) || inferDataColumnsFromRows(list);
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const changed = [];
    let inserted = 0;

    for (const row of list) {
      const now = nowBeijingDateTime();
      const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
      const records = tx.objectStore(RECORDS_STORE);
      let existing = null;

      if (!existing && normalizedDedupField && row[normalizedDedupField] != null) {
        existing = await findFirstByDataField(records.index("table"), name, normalizedDedupField, row[normalizedDedupField]);
      }

      const cleanData = cloneJsonObject(row);

      if (existing) {
        const next = {
          ...existing,
          id: existing.id,
          table: name,
          data: { ...existing.data, ...cleanData },
          updatedAt: now,
          revision: nextRecordRevision(existing),
        };
        records.put(next);
        changed.push(next);
        await touchTable(tx, name, { now, columns: columnOrder });
      } else {
        const id = await allocateDataRowId(records);
        const [order] = await allocateDataRowOrders(tx, name, 1, { position, now });
        const record = {
          id,
          table: name,
          order,
          data: cleanData,
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        records.add(record);
        changed.push(record);
        inserted += 1;
        await touchTable(tx, name, { countDelta: 1, now, columns: columnOrder });
      }
      await txDone(tx);
    }

    return { records: changed, inserted, updated: changed.length - inserted };
  });
}

export async function getDataRow(id: string) {
  if (!id) throw new Error("id is required");
  const db = await openDataDb();
  await ensureDataStoreRepaired(db);
  const record = await requestToPromise<DataRow | undefined>(db.transaction(RECORDS_STORE, "readonly").objectStore(RECORDS_STORE).get(id));
  return normalizeRecordForRead(record);
}

export async function updateDataRow(id: string, data: unknown, { expectedData = null }: { expectedData?: unknown } = {}) {
  return enqueueDataStoreWrite(async () => {
    if (!id) throw new Error("id is required");
    const patch = cloneJsonObject(data);
    const expected = normalizeExpectedData(expectedData);
    return writeDataRow(id, existing => {
      assertDataRowExpectedData(existing, expected);
      return { ...existing.data, ...patch };
    });
  });
}

export async function replaceDataRow(id: string, data: unknown, { expectedRevision = null }: { expectedRevision?: unknown } = {}) {
  return enqueueDataStoreWrite(async () => {
    if (!id) throw new Error("id is required");
    const replacement = cloneJsonObject(data);
    const revision = normalizeExpectedRevision(expectedRevision);
    if (revision == null) throw new Error("expectedRevision is required");
    return writeDataRow(id, existing => {
      assertDataRowExpectedRevision(existing, revision);
      return replacement;
    });
  });
}

/** Called inside the write queue; validation and persistence use the same record and transaction. */
async function writeDataRow(id: string, update: (existing: DataRow) => Record<string, unknown>) {
  const db = await openDataDb();
  await ensureDataStoreRepaired(db);
  const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
  const records = tx.objectStore(RECORDS_STORE);
  const existing = await requestToPromise<DataRow | undefined>(records.get(id));
  if (!existing) {
    throw new DataStoreConflictError(t("data.rowMissing"), {
      id,
      reason: "record_not_found",
    });
  }
  const data = update(existing);
  const now = nowBeijingDateTime();
  const next = {
    ...existing,
    data,
    updatedAt: now,
    revision: nextRecordRevision(existing),
  };
  records.put(next);
  await touchTable(tx, existing.table, { now });
  await txDone(tx);
  return next;
}

export async function deleteDataRows(ids: string | readonly string[], { table = "" } = {}) {
  return enqueueDataStoreWrite(async () => {
    const list: readonly string[] = (typeof ids === "string" ? [ids] : ids).filter(Boolean);
    const expectedTable = String(table || "").trim() ? normalizeTableName(table) : "";
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const deletedByTable = new Map<string, number>();
    const deletedRecords = [];
    const notFound = [];
    const skipped = [];

    for (const id of list) {
      const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
      const records = tx.objectStore(RECORDS_STORE);
      const existing = await requestToPromise<DataRow | undefined>(records.get(id));
      if (existing) {
        if (expectedTable && existing.table !== expectedTable) {
          skipped.push({ id, table: existing.table, reason: "table_mismatch" });
        } else {
          records.delete(id);
          deletedByTable.set(existing.table, (deletedByTable.get(existing.table) || 0) + 1);
          deletedRecords.push(existing);
          await touchTable(tx, existing.table, { countDelta: -1 });
        }
      } else {
        notFound.push(id);
      }
      await txDone(tx);
    }

    return {
      deleted: [...deletedByTable.values()].reduce((sum, n) => sum + n, 0),
      tables: Object.fromEntries(deletedByTable),
      records: deletedRecords,
      notFound,
      skipped,
    };
  });
}

export async function clearDataTable(table: unknown) {
  return enqueueDataStoreWrite(async () => {
    const name = normalizeTableName(table);
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
    const records = tx.objectStore(RECORDS_STORE);
    const index = records.index("table");
    let deleted = 0;

    tx.objectStore(TABLES_STORE).delete(name);
    await cursorPromise(index.openCursor(IDBKeyRange.only(name)), (cursor) => {
      cursor.delete();
      deleted += 1;
      cursor.continue();
    });
    await txDone(tx);
    return { table: name, deleted };
  });
}

export async function queryDataRows({ table = "", limit = 100, offset = 0, filter = {} }: DataQuery = {}) {
  const end = startDataStoreTrace("query_rows", { table: String(table || ""), limit, offset });
  try {
    const db = await openDataDb();
    await ensureDataStoreRepaired(db);
    const tableName = table ? normalizeTableName(table) : "";
    const max = clampInt(limit, 1, 100000, 100);
    const start = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const hasFilter = hasDataRowFilter(filter);
    const tx = db.transaction(RECORDS_STORE, "readonly");
    const records = tx.objectStore(RECORDS_STORE);
    const source = tableName ? records.index("table").openCursor(IDBKeyRange.only(tableName)) : records.openCursor();
    const matched: RowOrderEntry[] = [];

    await cursorPromise(source, (cursor) => {
      const value = cursor.value as DataRow;
      if (matchesFilter(value.data, filter)) {
        matched.push({
          record: normalizeRecordForRead(value),
          fallbackOrder: (matched.length + 1) * DATA_ROW_ORDER_STEP,
        });
      }
      cursor.continue();
    });
    await txDone(tx);
    matched.sort(compareDataRowOrderEntries);
    const out = matched.slice(start, start + max).map(entry => entry.record);
    end({ table: tableName, returned: out.length, totalMatched: matched.length, path: hasFilter ? "filtered_ordered_cursor" : "ordered_cursor" });
    return { rows: out, totalMatched: matched.length, limit: max, offset: start };
  } catch (err) {
    end({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export function inferColumns(records: readonly DataRow[], preferredColumns: unknown = []) {
  const keys = new Set(normalizeColumnOrder(preferredColumns) || []);
  for (const record of records || []) {
    for (const key of Object.keys(record.data || {})) keys.add(key);
  }
  keys.delete(ROW_ID_COLUMN);
  keys.delete("createdAt");
  keys.delete("updatedAt");
  return [ROW_ID_COLUMN, "createdAt", "updatedAt", ...keys];
}

function openDataDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        const records = db.createObjectStore(RECORDS_STORE, { keyPath: "id" });
        records.createIndex("table", "table", { unique: false });
        records.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(TABLES_STORE)) {
        db.createObjectStore(TABLES_STORE, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

async function touchTable(tx: IDBTransaction, table: string, { countDelta = 0, now = nowBeijingDateTime(), columns = null }: { countDelta?: number; now?: string; columns?: unknown } = {}) {
  const store = tx.objectStore(TABLES_STORE);
  const existing = await requestToPromise<DataTable | undefined>(store.get(table));
  const nextColumns = mergeColumnOrder(existing?.columns, columns);
  store.put({
    ...(existing || {}),
    name: table,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    count: Math.max(0, Number(existing?.count || 0) + countDelta),
    ...(nextColumns.length ? { columns: nextColumns } : {}),
  });
}

async function allocateDataRowOrders(tx: IDBTransaction, table: string, count: number, { position = "append", now = nowBeijingDateTime() } = {}) {
  const size = clampInt(count, 0, Number.MAX_SAFE_INTEGER, 0);
  if (size <= 0) return [];
  const store = tx.objectStore(TABLES_STORE);
  const existing = await requestToPromise<DataTable | undefined>(store.get(table));
  const existingCount = Math.max(0, Number(existing?.count || 0));
  let nextAppendOrder = normalizeDataRowOrderCursor(existing?.nextAppendOrder, (existingCount + 1) * DATA_ROW_ORDER_STEP);
  let nextPrependOrder = normalizeDataRowOrderCursor(existing?.nextPrependOrder, 0);

  let orders;
  if (position === "prepend") {
    const first = nextPrependOrder - (size - 1) * DATA_ROW_ORDER_STEP;
    orders = Array.from({ length: size }, (_item, index) => first + index * DATA_ROW_ORDER_STEP);
    nextPrependOrder = first - DATA_ROW_ORDER_STEP;
  } else {
    orders = Array.from({ length: size }, (_item, index) => nextAppendOrder + index * DATA_ROW_ORDER_STEP);
    nextAppendOrder += size * DATA_ROW_ORDER_STEP;
  }

  store.put({
    ...(existing || {}),
    name: table,
    createdAt: existing?.createdAt || now,
    updatedAt: existing?.updatedAt || now,
    count: Math.max(0, Number(existing?.count || 0)),
    nextAppendOrder,
    nextPrependOrder,
  });
  return orders;
}

function normalizeDataRowOrderCursor(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureDataStoreRepaired(db: IDBDatabase) {
  if (!repairReady) {
    repairReady = (async () => {
      await runDataStoreRepairOnce(db, RECORD_ID_REPAIR_MARKER, "repair_record_ids", () => repairDataRecordIds(db));
      await runDataStoreRepairOnce(db, ROW_ORDER_REPAIR_MARKER, "repair_row_order", () => repairDataRowOrder(db));
    })().catch((err) => {
      repairReady = null;
      throw err;
    });
  }
  return repairReady;
}

async function ensureDataTableIndexRepaired(db: IDBDatabase) {
  if (!tableIndexRepairReady) {
    tableIndexRepairReady = runDataStoreRepairOnce(db, TABLE_INDEX_REPAIR_MARKER, "repair_table_index", () => repairDataTableIndex(db)).catch((err) => {
      tableIndexRepairReady = null;
      throw err;
    });
  }
  return tableIndexRepairReady;
}

async function runDataStoreRepairOnce(db: IDBDatabase, markerKey: string, traceName: string, repairFn: () => Promise<void>) {
  const marker = await readDataStoreRepairMarker(db, markerKey);
  if (marker) {
    recordDataStoreTrace(traceName, 0, { skipped: true, marker: markerKey });
    return;
  }
  await repairFn();
  await writeDataStoreRepairMarker(db, markerKey);
}

async function repairDataRecordIds(db: IDBDatabase) {
  const end = startDataStoreTrace("repair_record_ids");
  const readTx = db.transaction(RECORDS_STORE, "readonly");
  const rows = await requestToPromise<DataRow[]>(readTx.objectStore(RECORDS_STORE).getAll());

  const seenIds = new Set();
  const existingIds = new Set(rows.map(record => String(record?.id || "")).filter(Boolean));
  const changes = [];

  for (const record of rows) {
    const oldId = String(record?.id || "");
    const table = String(record?.table || "").trim().slice(0, 120);
    const data = cloneRecordData(record?.data);

    if (!table || !oldId) {
      continue;
    }

    const sourceId = getLegacyRecordSourceId(record, data);
    let nextId = isSystemRecordId(oldId)
      ? oldId
      : createScopedRecordId(table);

    while (seenIds.has(nextId) || (nextId !== oldId && existingIds.has(nextId))) {
      nextId = createScopedRecordId(table);
    }
    seenIds.add(nextId);

    const dataChanged = Boolean(sourceId && data.id == null);
    const nextData = dataChanged ? { ...data, id: sourceId } : data;
    const idChanged = nextId !== oldId;
    const tableChanged = table !== record.table;
    const next = {
      ...record,
      id: nextId,
      table,
      data: nextData,
    };
    if (idChanged || tableChanged || dataChanged) {
      changes.push({ oldId, next });
    }
  }

  if (!changes.length) {
    end({ rows: rows.length, changes: 0 });
    return;
  }
  const tx = db.transaction(RECORDS_STORE, "readwrite");
  const records = tx.objectStore(RECORDS_STORE);
  for (const { oldId, next } of changes) {
    if (oldId !== next.id) records.delete(oldId);
    records.put(next);
  }
  await txDone(tx);
  end({ rows: rows.length, changes: changes.length });
}

async function repairDataRowOrder(db: IDBDatabase) {
  const end = startDataStoreTrace("repair_row_order");
  const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
  const records = tx.objectStore(RECORDS_STORE);
  const tables = tx.objectStore(TABLES_STORE);
  const existingTables = await requestToPromise<DataTable[]>(tables.getAll());
  const existingByName = new Map(existingTables.map(row => [row.name, row]));
  const groups = new Map<string, RowOrderEntry[]>();
  let scanned = 0;
  let changedRows = 0;

  await cursorPromise(records.openCursor(), (cursor) => {
    const record = cursor.value as DataRow;
    scanned += 1;
    const table = String(record?.table || "").trim().slice(0, 120);
    if (!table) {
      cursor.continue();
      return;
    }
    const group = groups.get(table) || [];
    group.push({
      record: { ...record, table },
      fallbackOrder: (group.length + 1) * DATA_ROW_ORDER_STEP,
    });
    groups.set(table, group);
    cursor.continue();
  });

  for (const [name, entries] of groups) {
    entries.sort(compareDataRowOrderEntries);
    for (const [index, entry] of entries.entries()) {
      const order = (index + 1) * DATA_ROW_ORDER_STEP;
      if (Number(entry.record?.order) === order && entry.record?.table === name) continue;
      records.put({
        ...entry.record,
        table: name,
        order,
      });
      changedRows += 1;
    }

    const existing = existingByName.get(name);
    const first = entries[0]?.record;
    const last = entries[entries.length - 1]?.record;
    tables.put({
      ...(existing || {}),
      name,
      createdAt: existing?.createdAt || first?.createdAt || nowBeijingDateTime(),
      updatedAt: existing?.updatedAt || last?.updatedAt || first?.updatedAt || nowBeijingDateTime(),
      count: entries.length,
      nextPrependOrder: 0,
      nextAppendOrder: (entries.length + 1) * DATA_ROW_ORDER_STEP,
    });
  }

  for (const existing of existingTables) {
    const name = existing?.name;
    if (!name || groups.has(name)) continue;
    if (Number.isFinite(Number(existing.nextAppendOrder)) && Number.isFinite(Number(existing.nextPrependOrder))) continue;
    tables.put({
      ...existing,
      nextPrependOrder: 0,
      nextAppendOrder: DATA_ROW_ORDER_STEP,
    });
  }

  await txDone(tx);
  end({ records: scanned, changedRows, tables: groups.size });
}

async function repairDataTableIndex(db: IDBDatabase) {
  const end = startDataStoreTrace("repair_table_index");
  const tx = db.transaction([RECORDS_STORE, TABLES_STORE], "readwrite");
  const records = tx.objectStore(RECORDS_STORE);
  const tables = tx.objectStore(TABLES_STORE);
  const existingRows = await requestToPromise<DataTable[]>(tables.getAll());
  const existingByName = new Map(existingRows.map(row => [row.name, row]));
  const actualByName = new Map<string, DataTable & { columns: string[] }>();
  let scanned = 0;
  let changedTables = 0;
  let staleTables = 0;

  await cursorPromise(records.openCursor(), (cursor) => {
    const record = cursor.value as DataRow;
    scanned += 1;
    const table = String(record?.table || "").trim().slice(0, 120);
    if (!table) {
      cursor.continue();
      return;
    }
    const current = actualByName.get(table) || {
      name: table,
      count: 0,
      createdAt: record.createdAt || record.updatedAt || nowBeijingDateTime(),
      updatedAt: record.updatedAt || record.createdAt || nowBeijingDateTime(),
      columns: [],
    };
    current.count += 1;
    current.columns = mergeColumnOrder(current.columns, inferDataColumnsFromRows([record.data || {}]));
    if (record.createdAt && record.createdAt < current.createdAt) current.createdAt = record.createdAt;
    if (record.updatedAt && compareBeijingDateTimeDesc(record.updatedAt, current.updatedAt) < 0) {
      current.updatedAt = record.updatedAt;
    }
    actualByName.set(table, current);
    cursor.continue();
  });

  for (const [name, actual] of actualByName) {
    const existing = existingByName.get(name);
    if (
      !existing
      || Number(existing.count || 0) !== actual.count
      || !existing.createdAt
      || !existing.updatedAt
      || !Array.isArray(existing.columns)
      || !columnOrderContains(existing.columns, actual.columns)
    ) {
      changedTables += 1;
      const columns = mergeColumnOrder(existing?.columns, actual.columns);
      tables.put({
        ...(existing || {}),
        name,
        createdAt: existing?.createdAt || actual.createdAt,
        updatedAt: actual.updatedAt || existing?.updatedAt || nowBeijingDateTime(),
        count: actual.count,
        ...(columns.length ? { columns } : {}),
      });
    }
  }

  for (const existing of existingRows) {
    const name = existing?.name;
    if (!name || actualByName.has(name) || Number(existing.count || 0) === 0) continue;
    staleTables += 1;
    tables.put({
      ...existing,
      count: 0,
      updatedAt: existing.updatedAt || nowBeijingDateTime(),
    });
  }

  await txDone(tx);
  end({ records: scanned, tables: actualByName.size, changedTables, staleTables });
}

function startDataStoreTrace(name: string, meta: Record<string, unknown> = {}) {
  const startedAt = dataStorePerfNow();
  return (extra = {}) => recordDataStoreTrace(name, dataStorePerfNow() - startedAt, { ...meta, ...extra });
}

function recordDataStoreTrace(name: string, ms: number, meta: Record<string, unknown> = {}) {
  const entry = {
    at: new Date().toISOString(),
    name,
    ms: Math.round(ms * 10) / 10,
    meta,
  };
  const buffer = getDataStoreTraceBuffer();
  buffer.push(entry);
  if (buffer.length > DATA_STORE_TRACE_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - DATA_STORE_TRACE_BUFFER_LIMIT);
  }
}

function getDataStoreTraceBuffer() {
  const host = globalThis as typeof globalThis & { __qingzhouDataStorePerf?: StoreTrace[] };
  if (!Array.isArray(host.__qingzhouDataStorePerf)) host.__qingzhouDataStorePerf = [];
  return host.__qingzhouDataStorePerf;
}

function dataStorePerfNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

async function readDataStoreRepairMarker(db: IDBDatabase, key: string) {
  if (!db?.objectStoreNames?.contains?.(META_STORE)) return null;
  const tx = db.transaction(META_STORE, "readonly");
  const marker = await requestToPromise<{key: string; completedAt: string} | undefined>(tx.objectStore(META_STORE).get(key));
  await txDone(tx);
  return marker?.key === key ? marker : null;
}

async function writeDataStoreRepairMarker(db: IDBDatabase, key: string) {
  if (!db?.objectStoreNames?.contains?.(META_STORE)) return;
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({
    key,
    completedAt: nowBeijingDateTime(),
  });
  await txDone(tx);
}

async function findFirstByDataField(index: IDBIndex, table: string, key: string, expected: unknown): Promise<DataRow | null> {
  let found: DataRow | null = null;
  await cursorPromise(index.openCursor(IDBKeyRange.only(table)), (cursor) => {
    const row = cursor.value as DataRow;
    if (Object.is(row?.data?.[key], expected)) {
      found = row;
      return false;
    }
    cursor.continue();
  });
  return found;
}

function cursorPromise(req: IDBRequest<IDBCursorWithValue | null>, onCursor: (cursor: IDBCursorWithValue) => void | false): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (onCursor(cursor) === false) resolve();
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB cursor failed"));
  });
}

function compareDataRowOrderEntries(a: RowOrderEntry, b: RowOrderEntry) {
  return dataRowSortOrder(a) - dataRowSortOrder(b)
    || compareDataRowCreatedAtAsc(a.record, b.record)
    || String(a.record?.id || "").localeCompare(String(b.record?.id || ""));
}

function dataRowSortOrder(entry: RowOrderEntry) {
  const order = Number(entry?.record?.order);
  return Number.isFinite(order) ? order : Number(entry?.fallbackOrder || 0);
}

function compareDataRowCreatedAtAsc(a: DataRow, b: DataRow) {
  const left = String(a?.createdAt || "");
  const right = String(b?.createdAt || "");
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function enqueueDataStoreWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = dataStoreWriteQueue.catch(() => {}).then(work);
  dataStoreWriteQueue = next.catch(() => {});
  return next;
}

function normalizeTableName(table: unknown) {
  const name = String(table || "").trim();
  if (!name) throw new Error("table is required");
  return name.slice(0, 120);
}

function normalizeDedupField(dedupField: unknown = "") {
  const field = String(dedupField || "").trim();
  if (!field) return "";
  if (field === ROW_ID_COLUMN || field.toLowerCase() === "rowid") {
    throw new Error("rowId is reserved and cannot be used as upsert dedupField; use a stable business field such as id, url, sourceId, or businessId");
  }
  return field;
}

async function allocateDataRowId(records: IDBObjectStore, reservedIds: Set<string> | null = null) {
  for (let attempt = 0; attempt < DATA_ROW_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const id = createDataRowId();
    if (reservedIds?.has(id) || (await requestToPromise<DataRow | undefined>(records.get(id)))) continue;
    reservedIds?.add(id);
    return id;
  }
  throw new Error("Unable to allocate a unique Data rowId");
}

function createDataRowId() {
  return `${DATA_ROW_ID_PREFIX}${createUuid()}`;
}

function createScopedRecordId(table: unknown) {
  const tablePart = encodeIdPart(normalizeTableName(table));
  return `table:${tablePart}:row:${createUuid()}`;
}

function isSystemRecordId(id: unknown) {
  const value = String(id || "");
  return value.startsWith(DATA_ROW_ID_PREFIX) || /^table:[^:]+:row:/i.test(value);
}

function encodeIdPart(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function normalizeSourceId(value: unknown) {
  if (value == null) return "";
  if (!["string", "number", "boolean"].includes(typeof value)) return "";
  return String(value).trim().slice(0, 240);
}

function getLegacyRecordSourceId(record: DataRow, data: Record<string, unknown>) {
  const dataId = normalizeSourceId(data?.id);
  if (dataId) return dataId;
  const id = String(record?.id || "");
  const scopedSourceId = decodeScopedSourceId(id);
  if (scopedSourceId) return scopedSourceId;
  return isSystemRecordId(id) || isGeneratedLegacyId(id) ? "" : normalizeSourceId(id);
}

function decodeScopedSourceId(id: unknown) {
  const match = String(id || "").match(/^table:[^:]+:id:(.+)$/i);
  if (!match) return "";
  try {
    return normalizeSourceId(decodeURIComponent(match[1]));
  } catch(_e) {
    return normalizeSourceId(match[1]);
  }
}

function isGeneratedLegacyId(id: unknown) {
  const value = String(id || "");
  return /^row_\d+_[a-z0-9]+$/i.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeRows(rows: unknown) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) throw new Error("rows must not be empty");
  return list.map(cloneJsonObject);
}

function inferDataColumnsFromRows(rows: unknown) {
  const columns = [];
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    const data = row && typeof row === "object" && !Array.isArray(row) ? row : {};
    for (const key of Object.keys(data)) {
      const column = normalizeColumnName(key);
      if (!column || isReservedColumn(column) || seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

function normalizeColumnOrder(columns: unknown) {
  if (!Array.isArray(columns)) return null;
  const out = [];
  const seen = new Set();
  for (const value of columns) {
    const column = normalizeColumnName(value);
    if (!column || isReservedColumn(column) || seen.has(column)) continue;
    seen.add(column);
    out.push(column);
  }
  return out;
}

function mergeColumnOrder(existingColumns: unknown, newColumns: unknown) {
  const out = normalizeColumnOrder(existingColumns) || [];
  const seen = new Set(out);
  for (const column of normalizeColumnOrder(newColumns) || []) {
    if (seen.has(column)) continue;
    seen.add(column);
    out.push(column);
  }
  return out;
}

function columnOrderContains(existingColumns: unknown, expectedColumns: unknown) {
  const existing = new Set(normalizeColumnOrder(existingColumns) || []);
  return (normalizeColumnOrder(expectedColumns) || []).every(column => existing.has(column));
}

function renameColumnOrder(existingColumns: unknown, from: string, to: string) {
  const out = [];
  const seen = new Set();
  const normalized = normalizeColumnOrder(existingColumns) || [];
  if (!normalized.includes(from)) normalized.push(from);
  for (const column of normalized) {
    const next = column === from ? to : column;
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

function normalizeColumnName(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEditableColumnName(value: unknown) {
  const column = normalizeColumnName(value);
  if (!column) throw new Error("column is required");
  if (isReservedColumn(column)) throw new Error(t("data.systemField", { field: String(column) }));
  return column.slice(0, 120);
}

function isReservedColumn(column: string) {
  return column === ROW_ID_COLUMN || column === "createdAt" || column === "updatedAt" || column === "table";
}

function normalizeColumnMeta(meta: unknown, columns: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const allowed = new Set(normalizeColumnOrder(columns) || []);
  const out: Record<string, DataColumnMeta> = {};
  for (const [key, value] of Object.entries(meta)) {
    const column = normalizeColumnName(key);
    if (!column || !allowed.has(column)) continue;
    const clean = normalizeSingleColumnMeta(value);
    if (Object.keys(clean).length) out[column] = clean;
  }
  return out;
}

function normalizeTableRecordForRead(row: DataTable): DataTable & { columns: string[]; columnMeta: Record<string, DataColumnMeta> };
function normalizeTableRecordForRead(row: DataTable | undefined): (DataTable & { columns: string[]; columnMeta: Record<string, DataColumnMeta> }) | undefined;
function normalizeTableRecordForRead(row: DataTable | undefined) {
  if (!row || typeof row !== "object") return row;
  const columns = normalizeColumnOrder(row.columns) || [];
  return {
    ...row,
    columns,
    columnMeta: normalizeColumnMeta(row.columnMeta, columns),
  };
}

function normalizeSingleColumnMeta(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: DataColumnMeta = {};
  const width = Number(input.width);
  if (Number.isFinite(width) && width >= 40 && width <= 1200) out.width = Math.round(width);
  const widthGrow = Number(input.widthGrow);
  if (Number.isFinite(widthGrow) && widthGrow > 0 && widthGrow <= 50) out.widthGrow = Math.round(widthGrow * 100) / 100;
  if (input.hidden === true) out.hidden = true;
  if (input.frozen === true) out.frozen = true;
  return out;
}

function renameColumnMeta(meta: unknown, columns: string[], from: string, to: string) {
  const existing = normalizeColumnMeta(meta, [...columns, from, to]);
  if (existing[from] && !existing[to]) existing[to] = existing[from];
  delete existing[from];
  return normalizeColumnMeta(existing, columns);
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("row/data must be a JSON object");
  }
  return JSON.parse(JSON.stringify(value));
}

function cloneRecordData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeRecordForRead(record: DataRow): DataRow & { revision: number };
function normalizeRecordForRead(record: DataRow | undefined): (DataRow & { revision: number }) | undefined;
function normalizeRecordForRead(record: DataRow | undefined) {
  if (!record) return record;
  return {
    ...record,
    data: cloneRecordData(record.data),
    revision: normalizeRecordRevision(record),
  };
}

function normalizeRecordRevision(record: DataRow | undefined) {
  const n = Number(record?.revision);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function nextRecordRevision(record: DataRow) {
  return normalizeRecordRevision(record) + 1;
}

function normalizeExpectedRevision(value: unknown) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("expectedRevision must be a non-negative integer");
  }
  return n;
}

function normalizeExpectedData(value: unknown) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expectedData must be a JSON object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = item === undefined ? undefined : JSON.parse(JSON.stringify(item));
  }
  return out;
}

function assertDataRowExpectedRevision(existing: DataRow, expectedRevision: number | null = null) {
  const currentRevision = normalizeRecordRevision(existing);
  if (expectedRevision != null && currentRevision !== expectedRevision) {
    throw new DataStoreConflictError(t("data.rowChanged"), {
      id: existing.id,
      table: existing.table,
      expectedRevision,
      currentRevision,
      reason: "revision_mismatch",
    });
  }
}

function assertDataRowExpectedData(existing: DataRow, expectedData: Record<string, unknown> | null = null) {
  if (!expectedData) return;
  const currentRevision = normalizeRecordRevision(existing);
  const currentData = cloneRecordData(existing.data);
  for (const [field, expectedValue] of Object.entries(expectedData)) {
    const currentValue = currentData[field];
    if (jsonValuesEqual(currentValue, expectedValue)) continue;
    throw new DataStoreConflictError(t("data.fieldConflict", { field: String(field) }), {
      id: existing.id,
      table: existing.table,
      field,
      expectedValue,
      currentValue,
      currentRevision,
      reason: "field_mismatch",
    });
  }
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonValuesEqual(item, b[index]));
  }
  if (typeof a === "object" || typeof b === "object") {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && jsonValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function matchesFilter(data: Record<string, unknown>, filter: unknown) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  return Object.entries(filter).every(([key, expected]) => Object.is(data?.[key], expected));
}

function hasDataRowFilter(filter: unknown) {
  return Boolean(filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length > 0);
}

async function readTableRecords(db: IDBDatabase, table: string) {
  const out: DataRow[] = [];
  const tx = db.transaction(RECORDS_STORE, "readonly");
  const index = tx.objectStore(RECORDS_STORE).index("table");
  await cursorPromise(index.openCursor(IDBKeyRange.only(table)), (cursor) => {
    out.push(normalizeRecordForRead(cursor.value));
    cursor.continue();
  });
  await txDone(tx);
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function createUuid() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("Secure random UUID generation is unavailable");
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}
