import { expect, test } from "./fixtures.mjs";

test("Data row IDs preserve existing records without an IndexedDB upgrade", async ({ page }) => {
  await page.goto("/__test_health");

  const result = await page.evaluate(async () => {
    const dbName = "qz-browser-agent-data";
    const table = "清水河:男生宿舍";
    const legacyId = `table:${encodeURIComponent(table)}:row:ba92bccb-0f76-4dfa-9848-c5a0a043c7c9`;
    const requestValue = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
    const transactionDone = transaction => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });

    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error || new Error("Failed to reset IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB reset was blocked"));
    });

    const seedDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const records = db.createObjectStore("records", { keyPath: "id" });
        records.createIndex("table", "table", { unique: false });
        records.createIndex("updatedAt", "updatedAt", { unique: false });
        db.createObjectStore("tables", { keyPath: "name" });
        db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to seed IndexedDB"));
    });
    const seedTransaction = seedDb.transaction(["records", "tables", "meta"], "readwrite");
    seedTransaction.objectStore("records").put({
      id: legacyId,
      table,
      order: 1000,
      data: { assetId: "asset:image:legacy", title: "Existing" },
      createdAt: "2026-01-01 10:00:00",
      updatedAt: "2026-01-01 10:00:00",
      revision: 3,
    });
    seedTransaction.objectStore("tables").put({
      name: table,
      kind: "image_collection",
      assetKind: "image",
      count: 1,
      columns: ["assetId", "title"],
      createdAt: "2026-01-01 10:00:00",
      updatedAt: "2026-01-01 10:00:00",
      nextPrependOrder: 0,
      nextAppendOrder: 2000,
    });
    for (const key of ["repair.record_ids.v1", "repair.row_order.v1", "repair.table_index.v1"]) {
      seedTransaction.objectStore("meta").put({ key, completedAt: "2026-01-01 10:00:01" });
    }
    await transactionDone(seedTransaction);
    seedDb.close();

    const dataStore = await import(`/extension/shared/data-store.js?browser_row_id=${Date.now()}`);
    const [inserted] = await dataStore.insertDataRows(table, [{ title: "New" }]);
    const listed = await dataStore.queryDataRows({ table, limit: 10 });
    const updated = await dataStore.updateDataRow(legacyId, { title: "Updated" }, {
      expectedData: { title: "Existing" },
    });

    const inspectionDb = await requestValue(indexedDB.open(dbName));
    const inspectionTransaction = inspectionDb.transaction(["records", "tables", "meta"], "readonly");
    const rawRecordsPromise = requestValue(inspectionTransaction.objectStore("records").getAll());
    const rawTablePromise = requestValue(inspectionTransaction.objectStore("tables").get(table));
    const metaPromise = requestValue(inspectionTransaction.objectStore("meta").getAll());
    const version = inspectionDb.version;
    const stores = [...inspectionDb.objectStoreNames].sort();
    const recordIndexes = [...inspectionTransaction.objectStore("records").indexNames].sort();
    const [rawRecords, rawTable, meta] = await Promise.all([rawRecordsPromise, rawTablePromise, metaPromise]);
    await transactionDone(inspectionTransaction);
    inspectionDb.close();

    const deleted = await dataStore.deleteDataRows(legacyId, { table });
    const remaining = await dataStore.queryDataRows({ table, limit: 10 });
    return {
      legacyId,
      insertedId: inserted.id,
      listedIds: listed.rows.map(row => row.id),
      updatedId: updated.id,
      rawRecordIds: rawRecords.map(row => row.id),
      rawTable,
      metaKeys: meta.map(row => row.key).sort(),
      version,
      stores,
      recordIndexes,
      deleted: deleted.deleted,
      remainingIds: remaining.rows.map(row => row.id),
    };
  });

  expect(result.version).toBe(2);
  expect(result.stores).toEqual(["meta", "records", "tables"]);
  expect(result.recordIndexes).toEqual(["table", "updatedAt"]);
  expect(result.insertedId).toMatch(/^row:[0-9a-f-]{36}$/i);
  expect(result.listedIds).toEqual([result.legacyId, result.insertedId]);
  expect(result.updatedId).toBe(result.legacyId);
  expect(result.rawRecordIds).toContain(result.legacyId);
  expect(result.rawRecordIds).toContain(result.insertedId);
  expect(result.rawTable).toMatchObject({
    name: "清水河:男生宿舍",
    kind: "image_collection",
    assetKind: "image",
    count: 2,
  });
  expect(result.metaKeys).toEqual([
    "repair.record_ids.v1",
    "repair.row_order.v1",
    "repair.table_index.v1",
  ]);
  expect(result.deleted).toBe(1);
  expect(result.remainingIds).toEqual([result.insertedId]);
});
