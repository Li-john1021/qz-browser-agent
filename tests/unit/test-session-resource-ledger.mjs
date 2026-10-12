import assert from "node:assert/strict";
import {
  appendSessionResourceArtifacts,
  clearSessionResourceArtifacts,
  listSessionResourceArtifacts,
  mergeSessionResourceArtifacts,
  normalizeSessionResourceArtifact,
  SESSION_RESOURCE_LEDGER_KEY,
} from "../../src/shared/session/session-resource-ledger.js";

const previousChrome = globalThis.chrome;
const storageState = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: storageState[key] }),
      set: async (values) => Object.assign(storageState, values),
    },
  },
};

await Promise.all([
  appendSessionResourceArtifacts({
    sessionId: "s1",
    runId: "r1",
    toolCallId: "t1",
    sourceTool: "data_store",
    artifacts: [{ type: "data", table: "weather", rowCount: 3, updatedAt: "2026-06-23 10:00:00" }],
  }),
  appendSessionResourceArtifacts({
    sessionId: "s1",
    runId: "r2",
    toolCallId: "t2",
    sourceTool: "save_file",
    artifacts: [{ type: "file", filename: "report.md", size: 128, updatedAt: "2026-06-23 11:00:00" }],
  }),
  appendSessionResourceArtifacts({
    sessionId: "s2",
    runId: "r3",
    sourceTool: "data_store",
    artifacts: [{ type: "data", table: "weather", rowCount: 9, updatedAt: "2026-06-23 12:00:00" }],
  }),
]);

let s1 = await listSessionResourceArtifacts("s1");
assert.deepEqual(
  s1.map((item) => [item.sourceTool, item.table || item.filename]),
  [
    ["save_file", "report.md"],
    ["data_store", "weather"],
  ],
);
assert.equal(s1[0].sessionId, "s1");
assert.equal((await listSessionResourceArtifacts("s2")).length, 1);

await appendSessionResourceArtifacts({
  sessionId: "s1",
  runId: "r4",
  sourceTool: "collect_images",
  artifacts: [{ type: "data", kind: "image_collection", table: "weather", assetCount: 7, updatedAt: "2026-06-23 12:30:00" }],
});
s1 = await listSessionResourceArtifacts("s1");
assert.equal(s1.length, 2);
assert.equal(s1[0].table, "weather");
assert.equal(s1[0].kind, "image_collection");
assert.equal(s1[0].createdAt, "2026-06-23 10:00:00");

const normalizedData = normalizeSessionResourceArtifact({
  sessionId: "s1",
  type: "data",
  id: "photos",
  table: "photos",
  kind: "image_collection",
  totalRows: 2,
});
assert.equal(normalizedData.resourceKey, "data:table:photos");
assert.equal(normalizedData.artifactId, "");
assert.equal(normalizedData.table, "photos");
assert.equal(normalizedData.kind, "image_collection");

const migratedData = normalizeSessionResourceArtifact({
  sessionId: "s1",
  resourceKey: "data:artifact:photos",
  type: "data",
  artifactId: "photos",
  table: "photos",
  kind: "image_collection",
});
assert.equal(migratedData.resourceKey, "data:table:photos");

const normalizedImageCollectionType = normalizeSessionResourceArtifact({
  sessionId: "s1",
  type: "imageCollection",
  id: "gallery",
  totalRows: 2,
});
assert.equal(normalizedImageCollectionType.type, "data");
assert.equal(normalizedImageCollectionType.kind, "image_collection");
assert.equal(normalizedImageCollectionType.table, "gallery");
assert.equal(normalizedImageCollectionType.resourceKey, "data:table:gallery");

assert.deepEqual(
  mergeSessionResourceArtifacts(
    [{ sessionId: "x", type: "file", filename: "a.md", updatedAt: "2026-06-23 10:00:00" }],
    [{ sessionId: "x", type: "file", filename: "a.md", size: 10, updatedAt: "2026-06-23 10:01:00" }],
  ).map((item) => [item.filename, item.size]),
  [["a.md", 10]],
);

const mergedData = mergeSessionResourceArtifacts(
  [{ sessionId: "x", type: "data", id: "photos", table: "photos", totalRows: 1, updatedAt: "2026-06-23 10:00:00" }],
  [{ sessionId: "x", type: "imageCollection", id: "photos", table: "photos", totalRows: 2, updatedAt: "2026-06-23 10:01:00" }],
);
assert.equal(mergedData.length, 1);
assert.equal(mergedData[0].resourceKey, "data:table:photos");
assert.equal(mergedData[0].kind, "image_collection");
assert.equal(mergedData[0].totalRows, 2);

storageState[SESSION_RESOURCE_LEDGER_KEY].legacy = [
  { sessionId: "legacy", resourceKey: "data:artifact:photos", type: "data", artifactId: "photos", table: "photos", totalRows: 1 },
  { sessionId: "legacy", resourceKey: "data:table:photos", type: "data", table: "photos", kind: "image_collection", totalRows: 2 },
];
const legacy = await listSessionResourceArtifacts("legacy");
assert.equal(legacy.length, 1);
assert.equal(legacy[0].resourceKey, "data:table:photos");
assert.equal(legacy[0].kind, "image_collection");
assert.equal(legacy[0].totalRows, 2);

await clearSessionResourceArtifacts("s1");
assert.equal((await listSessionResourceArtifacts("s1")).length, 0);
assert.equal(Array.isArray(storageState[SESSION_RESOURCE_LEDGER_KEY].s2), true);

globalThis.chrome = previousChrome;

console.log("session resource ledger tests passed");
