import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatToolActionTitle } from "../../src/shared/tools/tool-metadata.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const previousIndexedDB = globalThis.indexedDB;
const previousIDBKeyRange = globalThis.IDBKeyRange;

async function runDataStoreDeleteTests() {
  globalThis.IDBKeyRange = {
    only(value) {
      return { type: "only", value };
    },
  };
  globalThis.indexedDB = createFakeIndexedDB();

  try {
    const dataStore = await import(`../../src/shared/data-store.js?test=${Date.now()}`);
    const {
      addDataTableColumn,
      deleteDataRows,
      deleteDataTableColumn,
      getDataRow,
      getDataTableColumns,
      insertDataRows,
      listDataTables,
      queryDataRows,
      renameDataTableColumn,
      replaceDataRow,
      setDataTableColumns,
      updateDataTableMetadata,
      updateDataRow,
      upsertDataRows,
    } = dataStore;

    const inserted = await insertDataRows("articles", [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/b", title: "B" },
    ]);
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].revision, 1, "inserted rows should start at revision 1");
    assert.match(inserted[0].id, /^row:[0-9a-f-]{36}$/i, "inserted rows should use opaque global row ids");
    assert.doesNotMatch(inserted[0].id, /articles/, "row ids should not duplicate the table name");

    const [unicodeTableRow] = await insertDataRows("中文:表/格", [{ title: "Unicode" }]);
    assert.match(unicodeTableRow.id, /^row:[0-9a-f-]{36}$/i, "unicode table names should not leak into row ids");
    assert.doesNotMatch(unicodeTableRow.id, /%|中文|表|格/, "row ids should not require table-name encoding");

    const businessIdUpsert = await upsertDataRows("business_id_key", [
      { id: "biz-1", value: "first" },
      { id: "biz-1", value: "second" },
    ], { dedupField: "id" });
    assert.equal(businessIdUpsert.inserted, 1, "business id should be a valid upsert dedupField");
    assert.equal(businessIdUpsert.updated, 1, "duplicate business id rows should update through dedupField");
    const businessIdRows = await queryDataRows({ table: "business_id_key", limit: 10 });
    assert.equal(businessIdRows.totalMatched, 1, "business id upsert should keep one row");
    assert.equal(businessIdRows.rows[0].data.id, "biz-1", "business id should stay in row data");
    assert.equal(businessIdRows.rows[0].data.value, "second", "business id upsert should apply the latest data");

    const emptyTableSchema = await setDataTableColumns("empty_table_schema", ["id", "distance", "amount"]);
    assert.equal(emptyTableSchema.name, "empty_table_schema", "create table schema should create a table record");
    assert.deepEqual(
      await getDataTableColumns("empty_table_schema"),
      ["id", "distance", "amount"],
      "empty table schema columns should be visible through schema reads",
    );
    const emptyTableRows = await queryDataRows({ table: "empty_table_schema", limit: 10 });
    assert.equal(emptyTableRows.totalMatched, 0, "create table should not create sentinel rows");
    await Promise.all([
      updateDataTableMetadata("empty_table_schema", {
        label: "retained", name: "cannot-rename", count: 99, createdAt: "cannot-replace",
        columns: ["note"], columnMeta: { note: { hidden: true } },
      }),
      addDataTableColumn("empty_table_schema", "status", { meta: { width: 140 } }),
      setDataTableColumns("empty_table_schema", ["status", "note"]),
    ]);
    const schemaAfterQueue = (await listDataTables()).find(table => table.name === "empty_table_schema");
    assert.equal(schemaAfterQueue.label, "retained", "queued schema operations must preserve unrelated metadata");
    assert.equal(schemaAfterQueue.createdAt, emptyTableSchema.createdAt, "metadata patches cannot replace creation identity");
    assert.equal(schemaAfterQueue.count, 0, "metadata patches cannot forge the stored row count");
    assert.deepEqual(schemaAfterQueue.columns, ["status", "note"], "each schema edit must read the preceding committed edit");
    assert.deepEqual(schemaAfterQueue.columnMeta, { status: { width: 140 }, note: { hidden: true } });
    await assert.rejects(
      () => upsertDataRows("empty_upsert_without_columns", []),
      /rows must not be empty/,
      "upsert should reject empty rows; use create_table for empty schemas",
    );
    await assert.rejects(
      () => insertDataRows("empty_insert", []),
      /rows must not be empty/,
      "insert should still reject empty rows",
    );

    await assert.rejects(
      () => upsertDataRows("reserved_key", [{ _rowId: "x", value: "bad" }], { dedupField: "_rowId" }),
      /rowId is reserved/,
      "legacy row id fields should remain reserved as a dedupField",
    );
    await assert.rejects(
      () => upsertDataRows("reserved_key", [{ rowId: "x", value: "bad" }], { dedupField: "rowId" }),
      /rowId is reserved/,
      "rowId should remain reserved as a dedupField",
    );

    const orderedBase = await insertDataRows("ordered_rows", [
      { title: "A" },
      { title: "B" },
    ]);
    assert.ok(orderedBase[0].order < orderedBase[1].order, "append writes should preserve input order");
    const [orderedTop] = await insertDataRows("ordered_rows", [{ title: "TOP" }], { position: "prepend" });
    assert.ok(orderedTop.order < orderedBase[0].order, "prepend writes should receive an order before existing rows");
    let orderedRows = await queryDataRows({ table: "ordered_rows", limit: 10 });
    assert.deepEqual(
      orderedRows.rows.map(row => row.data.title),
      ["TOP", "A", "B"],
      "query should return rows in stable display order",
    );
    orderedRows = await queryDataRows({ table: "ordered_rows", limit: 1, offset: 1 });
    assert.deepEqual(
      orderedRows.rows.map(row => row.data.title),
      ["A"],
      "ordered pagination should apply after display ordering",
    );

    globalThis.__qingzhouDataStorePerf = [];
    const reloadedDataStore = await import(`../../src/shared/data-store.js?reload=${Date.now()}`);
    await reloadedDataStore.listDataTables();
    const reloadRepairTrace = globalThis.__qingzhouDataStorePerf.find(entry => entry?.name === "repair_record_ids");
    assert.equal(
      reloadRepairTrace?.meta?.skipped,
      true,
      "data-store record-id repair should be skipped after its repair marker survives extension reload",
    );

    globalThis.__qingzhouDataStorePerf = [];
    const reloadedAgainDataStore = await import(`../../src/shared/data-store.js?reload_again=${Date.now()}`);
    await reloadedAgainDataStore.listDataTables();
    const secondReloadRecordRepairTrace = globalThis.__qingzhouDataStorePerf.find(entry => entry?.name === "repair_record_ids");
    const secondReloadRowOrderRepairTrace = globalThis.__qingzhouDataStorePerf.find(entry => entry?.name === "repair_row_order");
    const secondReloadTableRepairTrace = globalThis.__qingzhouDataStorePerf.find(entry => entry?.name === "repair_table_index");
    assert.equal(
      secondReloadRecordRepairTrace?.meta?.skipped,
      true,
      "record-id repair should stay skipped across repeated extension reloads",
    );
    assert.equal(
      secondReloadRowOrderRepairTrace?.meta?.skipped,
      true,
      "row-order repair should stay skipped after its repair marker survives extension reload",
    );
    assert.equal(
      secondReloadTableRepairTrace?.meta?.skipped,
      true,
      "table-index repair should be skipped after its repair marker survives extension reload",
    );

    const [deleteA, deleteAAgain, upsertC] = await Promise.all([
      deleteDataRows(inserted[0].id, { table: "articles" }),
      deleteDataRows(inserted[0].id, { table: "articles" }),
      upsertDataRows("articles", [{ url: "https://example.com/c", title: "C" }], { dedupField: "url" }),
    ]);
    assert.equal(deleteA.deleted + deleteAAgain.deleted, 1, "concurrent duplicate delete should remove one row once");
    assert.equal(upsertC.inserted, 1);

    let listed = await queryDataRows({ table: "articles", limit: 10 });
    assert.deepEqual(
      listed.rows.map(row => row.data.title).sort(),
      ["B", "C"],
      "delete and concurrent upsert should serialize without losing unrelated rows",
    );

    const mismatch = await deleteDataRows(inserted[1].id, { table: "other_table" });
    assert.equal(mismatch.deleted, 0);
    assert.equal(mismatch.skipped[0].reason, "table_mismatch");
    listed = await queryDataRows({ table: "articles", limit: 10 });
    assert.equal(listed.totalMatched, 2, "table guard should keep the row when table does not match");
    listed = await queryDataRows({ table: "articles", limit: 1, offset: 1 });
    assert.equal(listed.totalMatched, 2, "unfiltered preview pagination should keep the full table count");
    assert.equal(listed.rows.length, 1, "unfiltered preview pagination should only return the requested window");

    const tables = await listDataTables();
    const articles = tables.find(table => table.name === "articles");
    assert.equal(articles.count, 2, "table count should stay consistent after duplicate and guarded deletes");

    await addDataTableColumn("articles", "score", { meta: { type: "number", width: 96 } });
    let schemaTables = await listDataTables();
    let schema = schemaTables.find(table => table.name === "articles");
    assert.deepEqual(schema.columns, ["url", "title", "score"], "schema add should append a metadata-only column");
    assert.deepEqual(schema.columnMeta.score, { width: 96 }, "schema add should persist layout meta and ignore type");

    await addDataTableColumn("empty_schema", "note", { meta: { type: "text" } });
    const [emptySchemaRow] = await insertDataRows("empty_schema", [{}], { columns: ["note"] });
    const editedNewColumn = await updateDataRow(emptySchemaRow.id, { note: "filled" }, {
      expectedData: { note: undefined },
    });
    assert.equal(editedNewColumn.data.note, "filled", "metadata-only columns should accept first cell edits with missing-field CAS");
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "empty_schema");
    assert.deepEqual(schema.columns, ["note"], "empty-table schema columns should survive first row edit");
    assert.equal(schema.columnMeta.note, undefined, "empty-table schema should not persist type metadata");

    listed = await queryDataRows({ table: "articles", limit: 10 });
    await updateDataRow(listed.rows[0].id, { score: 9 });
    const renameResult = await renameDataTableColumn("articles", "score", "rating");
    assert.equal(renameResult.changed, 1, "schema rename should migrate rows that contain the old field");
    listed = await queryDataRows({ table: "articles", limit: 10 });
    assert.equal(listed.rows[0].data.score, undefined, "schema rename should remove the old field");
    assert.equal(listed.rows[0].data.rating, 9, "schema rename should keep the field value");
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "articles");
    assert.deepEqual(schema.columns, ["url", "title", "rating"], "schema rename should update column order");
    assert.deepEqual(schema.columnMeta.rating, { width: 96 }, "schema rename should move layout column meta");
    assert.equal(schema.columnMeta.score, undefined, "schema rename should remove old column meta");

    const deleteColumnResult = await deleteDataTableColumn("articles", "rating", { dropData: true });
    assert.equal(deleteColumnResult.changed, 1, "schema delete should migrate rows that contain the field");
    listed = await queryDataRows({ table: "articles", limit: 10 });
    assert.equal(listed.rows[0].data.rating, undefined, "schema delete should remove field data");
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "articles");
    assert.deepEqual(schema.columns, ["url", "title"], "schema delete should remove the column from metadata");
    assert.equal(schema.columnMeta.rating, undefined, "schema delete should remove column meta");

    const [rowSchema] = await insertDataRows("row_update_schema", [{ a: "1" }], { columns: ["a"] });
    await updateDataRow(rowSchema.id, { b: "2" }, { expectedData: { b: undefined } });
    assert.deepEqual(
      await getDataTableColumns("row_update_schema"),
      ["a"],
      "row update should not implicitly mutate table column order",
    );
    await addDataTableColumn("row_update_schema", "b");
    assert.deepEqual(
      await getDataTableColumns("row_update_schema"),
      ["a", "b"],
      "explicit add_column should make an existing row field visible in schema",
    );

    await insertDataRows("legacy_rename_order", [{ first: "1", middle: "2", last: "3" }], {
      columns: ["first", "middle", "last"],
    });
    await setDataTableColumns("legacy_rename_order", ["first", "last"]);
    await renameDataTableColumn("legacy_rename_order", "middle", "center");
    assert.deepEqual(
      await getDataTableColumns("legacy_rename_order"),
      ["first", "center", "last"],
      "schema rename should preserve row-order position even when old metadata missed the field",
    );

    await addDataTableColumn("articles", "hidden_note", { meta: { type: "text", hidden: true } });
    await setDataTableColumns("articles", ["url", "title"]);
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "articles");
    assert.equal(schema.columnMeta.hidden_note, undefined, "schema set should prune metadata for removed columns");

    await assert.rejects(
      () => addDataTableColumn("articles", "createdAt"),
      /系统字段/,
      "schema add should reject reserved system columns",
    );
    await setDataTableColumns("articles", ["url", "title", "title", "table", "link"], {
      columnMeta: {
        title: { type: "bad", width: 39, widthGrow: 0, hidden: true, frozen: true },
        url: { type: "url", width: 1201, widthGrow: 51 },
        link: { type: "url", width: 1200, widthGrow: 2.345 },
        missing: { type: "text", width: 80 },
      },
    });
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "articles");
    assert.deepEqual(schema.columns, ["url", "title", "link"], "schema set should dedupe and drop reserved columns");
    assert.deepEqual(schema.columnMeta.title, { hidden: true, frozen: true }, "schema meta should keep safe boolean flags");
    assert.equal(schema.columnMeta.url, undefined, "schema meta should drop type-only metadata");
    assert.deepEqual(schema.columnMeta.link, { width: 1200, widthGrow: 2.35 }, "schema meta should keep maximum safe widths and proportional weights");
    assert.equal(schema.columnMeta.missing, undefined, "schema meta should prune unknown columns");

    await updateDataTableMetadata("articles", {
      columns: ["url", "title", "link", "raw"],
      columnMeta: {
        link: { type: "url", width: 144 },
        raw: { type: "json" },
      },
    });
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "articles");
    assert.deepEqual(schema.columnMeta.link, { width: 144 }, "generic metadata update should keep layout meta");
    assert.equal(schema.columnMeta.raw, undefined, "generic metadata update should not reintroduce type metadata");

    const conflictRows = await insertDataRows("schema_conflict", [
      { a: 1, b: 2 },
      { a: 3 },
    ], { columns: ["a", "b"] });
    await assert.rejects(
      () => renameDataTableColumn("schema_conflict", "a", "b"),
      /无法安全重命名/,
      "schema rename should reject row-level field conflicts",
    );
    listed = await queryDataRows({ table: "schema_conflict", limit: 10 });
    const conflictRow = listed.rows.find(row => row.id === conflictRows[0].id);
    assert.deepEqual(conflictRow.data, { a: 1, b: 2 }, "failed schema rename should not mutate row data");
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "schema_conflict");
    assert.deepEqual(schema.columns, ["a", "b"], "failed schema rename should not mutate column order");

    await addDataTableColumn("schema_conflict", "note", { meta: { type: "text" } });
    await updateDataRow(conflictRows[1].id, { note: "keep me" });
    const keepDataResult = await deleteDataTableColumn("schema_conflict", "note", { dropData: false });
    assert.equal(keepDataResult.changed, 0, "schema-only delete should not rewrite rows");
    listed = await queryDataRows({ table: "schema_conflict", limit: 10 });
    const noteRow = listed.rows.find(row => row.id === conflictRows[1].id);
    assert.equal(noteRow.data.note, "keep me", "schema-only delete should keep row data");
    schemaTables = await listDataTables();
    schema = schemaTables.find(table => table.name === "schema_conflict");
    assert.deepEqual(schema.columns, ["a", "b", "note"], "schema-only delete should keep data-backed columns indexable");
    assert.deepEqual(schema.columnMeta.note, { hidden: true }, "schema-only delete should hide retained data-backed columns");

    const [casRow] = await insertDataRows("cas_table", [{ name: "A", price: 10 }]);
    const casBase = await getDataRow(casRow.id);
    assert.equal(casBase.revision, 1, "get should expose row revision");
    const revisionReplace = await replaceDataRow(casBase.id, { name: "A", price: 11 }, {
      expectedRevision: casBase.revision,
    });
    assert.equal(revisionReplace.revision, casBase.revision + 1, "replace should advance row revision");
    assert.deepEqual(revisionReplace.data, { name: "A", price: 11 }, "revision-guarded replace should overwrite the row data when revision matches");
    await assert.rejects(
      () => replaceDataRow(casBase.id, { name: "A", price: 12 }, {
        expectedRevision: casBase.revision,
      }),
      err => err?.code === "DATA_ROW_CONFLICT" && err?.details?.reason === "revision_mismatch",
      "stale expectedRevision should reject the replace",
    );

    const fieldBase = await getDataRow(casRow.id);
    await updateDataRow(casRow.id, { city: "Hangzhou" });
    const fieldMerge = await updateDataRow(casRow.id, { name: "Manual" }, {
      expectedData: { name: fieldBase.data.name },
    });
    assert.equal(fieldMerge.data.city, "Hangzhou", "field-level CAS should preserve unrelated concurrent fields");
    assert.equal(fieldMerge.data.name, "Manual", "field-level CAS should update the guarded field");
    await assert.rejects(
      () => updateDataRow(casRow.id, { name: "Late writer" }, {
        expectedData: { name: fieldBase.data.name },
      }),
      err => err?.code === "DATA_ROW_CONFLICT" && err?.details?.reason === "field_mismatch",
      "stale expectedData should reject same-field overwrites",
    );

    const concurrentBase = await getDataRow(casRow.id);
    const concurrentReplacements = await Promise.allSettled([
      replaceDataRow(casRow.id, { name: "first" }, { expectedRevision: concurrentBase.revision }),
      replaceDataRow(casRow.id, { name: "second" }, { expectedRevision: concurrentBase.revision }),
    ]);
    assert.equal(concurrentReplacements[0].status, "fulfilled");
    assert.equal(concurrentReplacements[1].status, "rejected");
    assert.equal(concurrentReplacements[1].reason.details.reason, "revision_mismatch");
    const afterConflict = await updateDataRow(casRow.id, { recovered: true }, { expectedData: { name: "first" } });
    assert.deepEqual(afterConflict.data, { name: "first", recovered: true }, "a rejected write must not poison later queued edits");
    await deleteDataRows(casRow.id);
    await assert.rejects(
      () => replaceDataRow(casRow.id, { name: "resurrected" }, { expectedRevision: afterConflict.revision }),
      error => error?.code === "DATA_ROW_CONFLICT" && error?.details?.reason === "record_not_found",
    );
    assert.equal(await getDataRow(casRow.id), undefined, "late replacement must not resurrect a deleted record");

    const [blankRow] = await insertDataRows("cas_table", [{ title: "blank" }]);
    await updateDataRow(blankRow.id, { note: "filled elsewhere" });
    await assert.rejects(
      () => updateDataRow(blankRow.id, { note: "manual fill" }, {
        expectedData: { note: undefined },
      }),
      err => err?.code === "DATA_ROW_CONFLICT" && err?.details?.field === "note",
      "field-level CAS should treat a missing field as a real expected state",
    );

    await assertExistingScopedRowIdsStayUnchanged();
    await assertRowIdCollisionRetry();
    await assertBatchInsertRowIdCollisionRetry();
    await assertUpsertRowIdCollisionRetry();
    await assertRowIdCollisionExhaustionIsAtomic();
    await assertSecureUuidFallbacks();
    await assertLegacyRowOrderRepair();
    await assertDataStoreToolContract();
  } finally {
    globalThis.indexedDB = previousIndexedDB;
    globalThis.IDBKeyRange = previousIDBKeyRange;
  }

  console.log("data store delete tests passed");
}

async function assertExistingScopedRowIdsStayUnchanged() {
  globalThis.indexedDB = createFakeIndexedDB();
  const table = "清水河:男生宿舍";
  const legacyId = `table:${encodeURIComponent(table)}:row:ba92bccb-0f76-4dfa-9848-c5a0a043c7c9`;
  await seedLegacyDataStore({
    records: [{
      id: legacyId,
      table,
      order: 1000,
      data: { assetId: "asset:image:first", title: "Existing" },
      createdAt: "2026-01-01 10:00:00",
      updatedAt: "2026-01-01 10:00:00",
      revision: 3,
    }],
    tables: [{
      name: table,
      kind: "image_collection",
      assetKind: "image",
      count: 1,
      columns: ["assetId", "title"],
      createdAt: "2026-01-01 10:00:00",
      updatedAt: "2026-01-01 10:00:00",
    }],
    meta: [{ key: "repair.record_ids.v1", completedAt: "2026-01-01 10:00:02" }],
  });

  globalThis.__qingzhouDataStorePerf = [];
  const dataStore = await import(`../../src/shared/data-store.js?preserve_scoped_id=${Date.now()}`);
  const [inserted] = await dataStore.insertDataRows(table, [{ title: "New" }]);
  const listed = await dataStore.queryDataRows({ table, limit: 10 });
  assert.deepEqual(
    listed.rows.map(row => row.id),
    [legacyId, inserted.id],
    "existing row IDs should remain byte-for-byte unchanged while new rows use the new format",
  );
  assert.match(inserted.id, /^row:[0-9a-f-]{36}$/i);
  assert.equal((await dataStore.getDataRow(legacyId))?.data?.assetId, "asset:image:first");
  const updated = await dataStore.updateDataRow(legacyId, { title: "Updated" }, {
    expectedData: { title: "Existing" },
  });
  assert.equal(updated.id, legacyId, "editing an existing row must not rewrite its primary key");
  assert.equal((await dataStore.listDataTables()).find(item => item.name === table)?.count, 2);

  const deleted = await dataStore.deleteDataRows(legacyId, { table });
  assert.equal(deleted.deleted, 1, "existing row IDs should keep working for delete");
  assert.equal((await dataStore.queryDataRows({ table, limit: 10 })).totalMatched, 1);
  assert.equal(
    globalThis.__qingzhouDataStorePerf.find(entry => entry?.name === "repair_record_ids")?.meta?.skipped,
    true,
    "the existing v1 repair marker should remain authoritative; no new ID migration should run",
  );
}

async function assertRowIdCollisionRetry() {
  globalThis.indexedDB = createFakeIndexedDB();
  const collisionUuid = "11111111-1111-4111-8111-111111111111";
  const nextUuid = "22222222-2222-4222-8222-222222222222";
  await seedSingleDataRow("collision_table", `row:${collisionUuid}`, { title: "Existing" });

  const generated = [collisionUuid, nextUuid];
  await withTestCrypto({
    randomUUID() {
      return generated.shift() || nextUuid;
    },
  }, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?row_id_collision=${Date.now()}`);
    const [inserted] = await dataStore.insertDataRows("collision_table", [{ title: "New" }]);
    assert.equal(inserted.id, `row:${nextUuid}`, "row-id allocation should retry after a primary-key collision");
    const listed = await dataStore.queryDataRows({ table: "collision_table", limit: 10 });
    assert.deepEqual(
      listed.rows.map(row => row.data.title),
      ["Existing", "New"],
      "collision retry must never overwrite an existing row",
    );
  });
}

async function assertBatchInsertRowIdCollisionRetry() {
  globalThis.indexedDB = createFakeIndexedDB();
  const firstUuid = "33333333-3333-4333-8333-333333333333";
  const secondUuid = "44444444-4444-4444-8444-444444444444";
  const generated = [firstUuid, firstUuid, secondUuid];
  let calls = 0;
  await withTestCrypto({
    randomUUID() {
      calls += 1;
      return generated.shift() || secondUuid;
    },
  }, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?batch_row_id_collision=${Date.now()}`);
    const inserted = await dataStore.insertDataRows("batch_collision", [
      { title: "First" },
      { title: "Second" },
    ]);
    assert.deepEqual(
      inserted.map(row => row.id),
      [`row:${firstUuid}`, `row:${secondUuid}`],
      "one batch should reserve generated IDs before writing and retry an in-batch duplicate",
    );
    assert.equal(calls, 3, "the second row should consume one retry after matching the first row's reserved ID");
    assert.deepEqual(
      (await dataStore.queryDataRows({ table: "batch_collision", limit: 10 })).rows.map(row => row.data.title),
      ["First", "Second"],
      "in-batch collision handling should preserve every input row and its order",
    );
  });
}

async function assertUpsertRowIdCollisionRetry() {
  globalThis.indexedDB = createFakeIndexedDB();
  const collisionUuid = "55555555-5555-4555-8555-555555555555";
  const nextUuid = "66666666-6666-4666-8666-666666666666";
  await seedSingleDataRow(
    "upsert_collision",
    `row:${collisionUuid}`,
    { key: "existing", title: "Existing" },
  );

  const generated = [collisionUuid, nextUuid];
  await withTestCrypto({
    randomUUID() {
      return generated.shift() || nextUuid;
    },
  }, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?upsert_row_id_collision=${Date.now()}`);
    const result = await dataStore.upsertDataRows("upsert_collision", [
      { key: "new", title: "New" },
    ], { dedupField: "key" });
    assert.equal(result.inserted, 1);
    assert.equal(result.records[0]?.id, `row:${nextUuid}`, "upsert's insert branch should retry a stored-ID collision");
    const listed = await dataStore.queryDataRows({ table: "upsert_collision", limit: 10 });
    assert.deepEqual(listed.rows.map(row => row.data.title), ["Existing", "New"]);
  });
}

async function assertRowIdCollisionExhaustionIsAtomic() {
  globalThis.indexedDB = createFakeIndexedDB();
  const collisionUuid = "77777777-7777-4777-8777-777777777777";
  await seedSingleDataRow("collision_exhaustion", `row:${collisionUuid}`, { title: "Existing" });

  let calls = 0;
  await withTestCrypto({
    randomUUID() {
      calls += 1;
      return collisionUuid;
    },
  }, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?row_id_exhaustion=${Date.now()}`);
    const before = (await dataStore.listDataTables()).find(table => table.name === "collision_exhaustion");
    await assert.rejects(
      () => dataStore.insertDataRows("collision_exhaustion", [{ title: "Must not persist" }]),
      /Unable to allocate a unique Data rowId/,
      "eight consecutive collisions should terminate with an explicit error",
    );
    assert.equal(calls, 8, "row-id allocation should stop at its bounded retry limit");
    await assert.rejects(
      () => dataStore.upsertDataRows("collision_exhaustion", [{ key: "new", title: "Must not persist" }], {
        dedupField: "key",
      }),
      /Unable to allocate a unique Data rowId/,
      "upsert's insert branch should use the same bounded collision policy",
    );
    assert.equal(calls, 16, "insert and upsert should each stop after eight allocation attempts");
    const listed = await dataStore.queryDataRows({ table: "collision_exhaustion", limit: 10 });
    assert.deepEqual(listed.rows.map(row => row.data.title), ["Existing"], "collision exhaustion must not add a row");
    const after = (await dataStore.listDataTables()).find(table => table.name === "collision_exhaustion");
    assert.deepEqual(after, before, "collision exhaustion must not advance table order cursors or metadata");
  });
}

async function assertSecureUuidFallbacks() {
  globalThis.indexedDB = createFakeIndexedDB();
  let fallbackCalls = 0;
  await withTestCrypto({
    getRandomValues(bytes) {
      fallbackCalls += 1;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  }, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?uuid_fallback=${Date.now()}`);
    const [inserted] = await dataStore.insertDataRows("uuid_fallback", [{ title: "Fallback" }]);
    assert.equal(inserted.id, "row:00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.equal(fallbackCalls, 1, "the secure byte fallback should be used once per allocated UUID");
  });

  globalThis.indexedDB = createFakeIndexedDB();
  await withTestCrypto({}, async () => {
    const dataStore = await import(`../../src/shared/data-store.js?uuid_unavailable=${Date.now()}`);
    await assert.rejects(
      () => dataStore.insertDataRows("uuid_unavailable", [{ title: "Must not persist" }]),
      /Secure random UUID generation is unavailable/,
      "missing secure randomness should fail explicitly",
    );
    assert.equal((await dataStore.queryDataRows({ table: "uuid_unavailable", limit: 10 })).totalMatched, 0);
    assert.equal(
      (await dataStore.listDataTables()).some(table => table.name === "uuid_unavailable"),
      false,
      "missing secure randomness must fail before creating table metadata",
    );
  });
}

async function withTestCrypto(value, work) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
  try {
    return await work();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
}

async function assertLegacyRowOrderRepair() {
  globalThis.indexedDB = createFakeIndexedDB();
  await seedLegacyDataStore({
    records: [
      {
        id: "legacy-a",
        table: "legacy_order",
        data: { title: "A" },
        createdAt: "2026-01-01 10:00:00",
        updatedAt: "2026-01-01 10:00:00",
        revision: 1,
      },
      {
        id: "legacy-b",
        table: "legacy_order",
        data: { title: "B" },
        createdAt: "2026-01-01 10:00:00",
        updatedAt: "2026-01-01 10:00:00",
        revision: 1,
      },
    ],
    tables: [
      {
        name: "legacy_order",
        count: 2,
        columns: ["title"],
        createdAt: "2026-01-01 10:00:00",
        updatedAt: "2026-01-01 10:00:00",
      },
    ],
  });

  const dataStore = await import(`../../src/shared/data-store.js?legacy_order=${Date.now()}`);
  let listed = await dataStore.queryDataRows({ table: "legacy_order", limit: 10 });
  assert.deepEqual(
    listed.rows.map(row => row.data.title),
    ["A", "B"],
    "legacy row-order repair should preserve the readable legacy order",
  );
  assert.deepEqual(
    listed.rows.map(row => row.order),
    [1000, 2000],
    "legacy row-order repair should persist dense display order values",
  );

  await dataStore.insertDataRows("legacy_order", [{ title: "TOP" }], { position: "prepend" });
  await dataStore.insertDataRows("legacy_order", [{ title: "C" }]);
  listed = await dataStore.queryDataRows({ table: "legacy_order", limit: 10 });
  assert.deepEqual(
    listed.rows.map(row => row.data.title),
    ["TOP", "A", "B", "C"],
    "repaired tables should support prepend and append order cursors",
  );
}

async function seedLegacyDataStore({ records = [], tables = [], meta = [] } = {}) {
  const db = await openSeedDb();
  const tx = db.transaction(["records", "tables", "meta"], "readwrite");
  const recordStore = tx.objectStore("records");
  const tableStore = tx.objectStore("tables");
  const metaStore = tx.objectStore("meta");
  for (const record of records) recordStore.put(record);
  for (const table of tables) tableStore.put(table);
  for (const item of meta) metaStore.put(item);
  await fakeTxDone(tx);
}

async function seedSingleDataRow(table, id, data) {
  const timestamp = "2026-01-01 10:00:00";
  return seedLegacyDataStore({
    records: [{
      id,
      table,
      order: 1000,
      data,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }],
    tables: [{
      name: table,
      count: 1,
      columns: Object.keys(data),
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
}

function openSeedDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("qz-browser-agent-data");
    req.onupgradeneeded = () => {
      const db = req.result;
      const records = db.createObjectStore("records", { keyPath: "id" });
      records.createIndex("table", "table", { unique: false });
      records.createIndex("updatedAt", "updatedAt", { unique: false });
      db.createObjectStore("tables", { keyPath: "name" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("failed to open seed db"));
  });
}

function fakeTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("seed transaction failed"));
  });
}

async function assertDataStoreToolContract() {
  const { registerDataTools } = await import("../../src/capabilities/data/tools.js");
  let definition;
  const { ToolExecutionError, validateToolSchema } = await import("../../src/background/tools/arguments.js");
  registerDataTools({ registerTool: value => { definition = value; }, ToolExecutionError, getToolRuntimeDependencies: () => ({}) });
  const modelDocumentation = JSON.stringify({ description: definition.description, parameters: definition.parameters });
  const dataToolsSource = readFileSync(join(root, "src/capabilities/data/tools.ts"), "utf8");
  const dataStoreSource = readFileSync(join(root, "src/shared/data-store.ts"), "utf8");
  const localizationSource = readFileSync(join(root, "src/shared/tools/tool-error-localization.ts"), "utf8")
    + readFileSync(join(root, "src/shared/i18n/backend-messages.ts"), "utf8");
  const timelineSource = readFileSync(join(root, "src/sidepanel/tools/tool-timeline-renderer.ts"), "utf8");
  assert.match(dataToolsSource, /enum:\s*\[[\s\S]*"delete"[\s\S]*"add_column"[\s\S]*"rename_column"[\s\S]*"delete_column"[\s\S]*\]/, "data_store schema should expose row and column actions");
  assert.match(modelDocumentation, /delete 只支持按单条 rowId 删除/, "data_store description should constrain delete to one rowId");
  assert.match(modelDocumentation, /row\.id 只是普通业务字段/, "data_store description should keep business id separate from rowId");
  assert.match(modelDocumentation, /rowId 是不透明值/, "data_store description should define rowId as an opaque handle");
  assert.match(modelDocumentation, /禁止拼接、解析、URL 编解码/, "rowId schema should forbid reconstructing storage identifiers");
  assert.match(dataToolsSource, /dedupField/, "data_store schema should expose dedupField for upserts");
  assert.match(modelDocumentation, /create_table 需 table \+ columns/, "data_store schema should expose explicit empty table creation");
  assert.doesNotMatch(dataToolsSource, /keyField/, "data_store implementation should not expose the old keyField name");
  assert.match(dataToolsSource, /expectedValue/, "data_store schema should expose field-level expectedValue CAS");
  assert.match(dataToolsSource, /revision/, "data_store schema should expose revision CAS for replace");
  assert.match(dataToolsSource, /getDataTableColumns\(table\)/, "data_store schema action should expose explicit table columns");
  assert.match(modelDocumentation, /schema 只返回当前字段顺序/, "data_store schema description should avoid a hidden type contract");
  assert.match(dataToolsSource, /addDataTableColumn\(table,\s*column\)/, "data_store add_column should use shared column path");
  assert.match(dataToolsSource, /renameDataTableColumn\(table,\s*column,\s*newColumn\)/, "data_store rename_column should use shared column path");
  assert.match(dataToolsSource, /deleteDataTableColumn\(table,\s*column,\s*\{\s*dropData:\s*true\s*\}\)/, "data_store delete_column should drop data through shared column path");
  const execute = async input => {
    definition.validateArgs(input);
    validateToolSchema("data_store", input, definition.parameters);
    return definition.execute(input, undefined, { sessionId: "data-contract" });
  };
  const inserted = await execute({ action: "insert", table: "tool_contract", rows: [{ title: "first" }] });
  const rowId = inserted.rowIdsSample[0];
  const read = await execute({ action: "get", rowId });
  assert.equal(read.table, "tool_contract");
  assert.equal(read.row.rowId, rowId);
  assert.equal("id" in read.row || "table" in read.row || "__table" in read.row, false);
  const updated = await execute({ action: "update", rowId, field: "title", value: { rich: true }, expectedValue: "first" });
  assert.deepEqual(updated.row.data.title, { rich: true });
  assert.equal(updated.updated, 1);
  await assert.rejects(execute({ action: "update", rowId, field: "title", value: "stale", expectedValue: "first" }), { code: "DATA_ROW_CONFLICT" });
  const replaced = await execute({ action: "replace", rowId, revision: updated.row.revision, data: { title: "complete" } });
  assert.equal(replaced.replaced, 1);
  assert.deepEqual(replaced.row.data, { title: "complete" });
  assert.equal("__table" in replaced.row, false);
  for (const [action, missing] of [["update", ["rowId", "field"]], ["replace", ["rowId", "revision", "data"]]]) {
    assert.throws(() => definition.validateArgs({ action }), error =>
      error.code === "MISSING_REQUIRED_ARGUMENTS" && JSON.stringify(error.details.missing) === JSON.stringify(missing));
  }
  assert.match(dataToolsSource, /deleteDataRows\(rowId,\s*\{\s*table\s*\}\)/, "data_store delete should use shared serialized delete path");
  assert.match(dataToolsSource, /MISSING_DATA_ROW_ID/, "data_store delete should reject missing rowId");
  assert.match(dataToolsSource, /DATA_ROW_NOT_FOUND/, "data_store should expose a stable not-found failure");
  assert.match(dataToolsSource, /DATA_ROW_TABLE_MISMATCH/, "data_store delete should reject table mismatches");
  assert.match(dataStoreSource, /const DB_VERSION = 2;/, "the row-id format change must not upgrade the IndexedDB schema");
  assert.match(dataStoreSource, /DATA_ROW_ID_PREFIX = "row:"/, "Data rows should use a table-independent public prefix");
  assert.match(dataStoreSource, /repair\.record_ids\.v1/, "the existing repair marker should remain unchanged");
  assert.doesNotMatch(dataStoreSource, /repair\.record_ids\.v2/, "the new row-id format should not introduce a data migration");
  assert.match(dataStoreSource, /rowIds\.push\(await allocateDataRowId\(records, reservedIds\)\)/, "batch inserts should reserve table-independent row IDs before writing");
  assert.match(dataStoreSource, /const id = await allocateDataRowId\(records\)/, "upsert inserts should allocate a table-independent row ID before writing");
  assert.match(dataStoreSource, /records\.add\(record\)/, "new rows should use add semantics instead of collision-prone overwrite semantics");
  assert.doesNotMatch(dataStoreSource, /Math\.random/, "row IDs should not use a weak random fallback");
  assert.match(localizationSource, /MISSING_DATA_ROW_ID/, "missing row id should have localized error copy");
  assert.match(localizationSource, /DATA_ROW_CONFLICT/, "row conflict should have localized error copy");
  assert.match(localizationSource, /DATA_ROW_NOT_FOUND/, "row not-found failures should have localized recovery copy");
  assert.match(localizationSource, /字段旧值/, "field update precondition should have localized error copy");
  assert.equal(formatToolActionTitle("data_store", { action: "delete" }), "删除数据行", "shared tool presentation should label data_store delete accurately");
  assert.equal(formatToolActionTitle("data_store", { action: "rename_column" }), "重命名字段", "shared tool presentation should label data_store column actions accurately");
  assert.match(timelineSource, /formatToolActionTitle\(toolOrName, args\)/, "timeline should use the shared action labeler");
}

function createFakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          db = new FakeDb();
          dbs.set(name, db);
        }
        request.result = db;
        if (fresh && typeof request.onupgradeneeded === "function") request.onupgradeneeded();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
}

class FakeDb {
  constructor() {
    this._stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this._stores.has(name),
    };
  }

  createObjectStore(name, options = {}) {
    const store = new FakeStoreData(options.keyPath || "id");
    this._stores.set(name, store);
    return new FakeObjectStore(store, new FakeTransaction(this));
  }

  transaction(names) {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.pending = 0;
    this.completed = false;
    this._oncomplete = null;
  }

  objectStore(name) {
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`missing store ${name}`);
    return new FakeObjectStore(store, this);
  }

  set oncomplete(handler) {
    this._oncomplete = handler;
    if (this.completed && typeof handler === "function") queueMicrotask(() => handler());
  }

  get oncomplete() {
    return this._oncomplete;
  }

  _begin() {
    this.pending += 1;
  }

  _end() {
    this.pending = Math.max(0, this.pending - 1);
    queueMicrotask(() => {
      if (this.pending === 0 && !this.completed) {
        this.completed = true;
        this._oncomplete?.();
      }
    });
  }
}

class FakeStoreData {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.rows = new Map();
    this.indexes = new Map();
  }
}

class FakeObjectStore {
  constructor(data, tx) {
    this.data = data;
    this.tx = tx;
  }

  createIndex(name, path) {
    this.data.indexes.set(name, path);
  }

  get(key) {
    return fakeRequest(this.tx, () => clone(this.data.rows.get(key)));
  }

  getAll() {
    return fakeRequest(this.tx, () => [...this.data.rows.values()].map(clone));
  }

  add(value) {
    return fakeRequest(this.tx, () => {
      const key = value?.[this.data.keyPath];
      if (this.data.rows.has(key)) throw new Error(`duplicate key ${key}`);
      this.data.rows.set(key, clone(value));
      return key;
    });
  }

  put(value) {
    return fakeRequest(this.tx, () => {
      const key = value?.[this.data.keyPath];
      this.data.rows.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return fakeRequest(this.tx, () => {
      this.data.rows.delete(key);
      return undefined;
    });
  }

  index(name) {
    const path = this.data.indexes.get(name);
    if (!path) throw new Error(`missing index ${name}`);
    return new FakeIndex(this.data, path, this.tx);
  }

  openCursor(range) {
    const rows = [...this.data.rows.values()].map(clone);
    return fakeCursorRequest(this.tx, rows, this.data, this.data.keyPath, range);
  }

  count(range) {
    return fakeRequest(this.tx, () => [...this.data.rows.values()]
      .filter(row => !range || range.type !== "only" || row?.[this.data.keyPath] === range.value)
      .length);
  }
}

class FakeIndex {
  constructor(data, path, tx) {
    this.data = data;
    this.path = path;
    this.tx = tx;
  }

  openCursor(range) {
    const rows = [...this.data.rows.values()]
      .filter(row => !range || range.type !== "only" || row?.[this.path] === range.value)
      .map(clone);
    return fakeCursorRequest(this.tx, rows, this.data, this.data.keyPath);
  }

  count(range) {
    return fakeRequest(this.tx, () => [...this.data.rows.values()]
      .filter(row => !range || range.type !== "only" || row?.[this.path] === range.value)
      .length);
  }
}

function fakeRequest(tx, work) {
  const request = {};
  tx._begin();
  queueMicrotask(() => {
    try {
      request.result = work();
      request.onsuccess?.();
    } catch (err) {
      request.error = err;
      request.onerror?.();
    } finally {
      tx._end();
    }
  });
  return request;
}

function fakeCursorRequest(tx, rows, storeData, keyPath) {
  const request = {};
  tx._begin();
  let index = 0;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    tx._end();
  };
  const emit = () => {
    const value = rows[index] || null;
    let moved = false;
    request.result = value
      ? {
          value,
          delete: () => storeData.rows.delete(value?.[keyPath]),
          continue: () => {
            moved = true;
            index += 1;
            queueMicrotask(emit);
          },
          advance: (count) => {
            moved = true;
            index += Math.max(1, Number(count) || 1);
            queueMicrotask(emit);
          },
        }
      : null;
    request.onsuccess?.();
    if (!request.result || !moved) finish();
  };
  queueMicrotask(emit);
  return request;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

await runDataStoreDeleteTests();
