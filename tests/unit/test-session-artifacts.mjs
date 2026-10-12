import assert from "node:assert/strict";
import { createSessionArtifacts } from "../../src/background/session/artifacts.js";

const metadata = new Map([
  ["s1", {
    id: "s1",
    title: "Artifacts",
    createdAt: "2026-07-12 10:00:00",
    updatedAt: "2026-07-12 10:00:00",
    listSummary: null,
  }],
]);
const resources = new Map();
const broadcasts = [];
let nowIndex = 0;

const repository = {
  async updateMetadata(sessionId, mutator) {
    const current = metadata.get(sessionId);
    if (!current) return { changed: false, session: null };
    const next = await mutator({ ...current });
    if (!next) return { changed: false, session: current };
    metadata.set(sessionId, next);
    return { changed: true, session: next };
  },
};

const transcript = [
  {
    type: "tool",
    name: "data_store",
    args: { action: "upsert", table: "places", rows: [{ name: "West Lake" }] },
    result: { table: "places", totalRows: 1, columns: ["name"] },
    endedAt: "2026-07-12 10:01:00",
  },
  {
    type: "tool",
    name: "document_create",
    args: { filename: "report.pdf" },
    result: { artifactId: "doc-1", filename: "report.pdf", downloaded: { downloadId: "dl-1" } },
    endedAt: "2026-07-12 10:02:00",
  },
  {
    type: "tool",
    name: "download_url",
    args: { url: "https://example.test/report.csv", filename: "Journey Report.csv" },
    result: { downloadId: 7, url: "https://example.test/report.csv", filename: "Journey Report.csv", artifactRecorded: true },
    endedAt: "2026-07-12 10:03:00",
  },
];

const artifacts = createSessionArtifacts({
  sessionRepository: repository,
  getSessions: async () => Object.fromEntries(metadata),
  ready: async () => {},
  normalizeSessionId: value => String(value || "").trim(),
  nowBeijingDateTime: () => `2026-07-12 10:10:${String(++nowIndex).padStart(2, "0")}`,
  broadcast: event => broadcasts.push(event),
  resolveSessionArtifactTranscript: async () => transcript,
  collectRunScriptToolArtifacts: (_name, _args, result) => Array.isArray(result?.artifacts) ? result.artifacts : [],
  getToolIdentity: name => ({ capabilityId: String(name || "").replace(/^plugin__/, "") }),
  listTables: async () => [{ name: "places", count: 1, columns: ["name"], updatedAt: "2026-07-12 10:03:00" }],
  async appendResources({ sessionId, artifacts: incoming }) {
    const existing = resources.get(sessionId) || [];
    const byKey = new Map(existing.map(item => [resourceKey(item), item]));
    for (const item of incoming) byKey.set(resourceKey(item), { ...byKey.get(resourceKey(item)), ...item });
    const next = [...byKey.values()];
    resources.set(sessionId, next);
    return next;
  },
  listResources: async sessionId => resources.get(sessionId) || [],
});

assert.deepEqual(artifacts.empty(), {
  total: 0,
  summary: { total: 0, imageCollections: 0, dataTables: 0, files: 0 },
  items: [],
  dataTables: [],
  imageCollections: [],
  files: [],
});

const initial = await artifacts.collect("s1", transcript);
assert.equal(initial.total, 3);
assert.equal(initial.dataTables.length, 1);
assert.equal(initial.files.length, 2);
assert.equal(initial.dataTables[0].table, "places");
assert.equal(initial.files.some(item => item.downloadId === "dl-1"), true);
const downloadedReport = initial.files.find(item => item.downloadId === "7");
assert.ok(downloadedReport);
assert.equal(downloadedReport.filename, "Journey Report.csv", "artifact should retain its logical filename rather than Chrome's physical path");

const event = {
  type: "tool_execution_end",
  isError: false,
  runId: "run-1",
  toolCallId: "call-1",
  toolName: "data_store",
  result: {
    artifacts: [{ type: "data", table: "places", title: "places", totalRows: 1 }],
  },
};
artifacts.recordResourceEvent("s1", event);
artifacts.recordResourceEvent("s1", event);
await waitFor(() => (resources.get("s1") || []).length === 1);
const afterRepeatedEvent = await artifacts.collect("s1", transcript);
assert.equal(afterRepeatedEvent.total, 3, "repeated resource events must not accumulate artifact counts");

const originalUpdatedAt = metadata.get("s1").updatedAt;
const firstSync = await artifacts.syncSummary("s1", afterRepeatedEvent);
const secondSync = await artifacts.syncSummary("s1", afterRepeatedEvent);
assert.equal(firstSync.updated, true);
assert.equal(secondSync.updated, false, "reconciling the same source of truth must be idempotent");
assert.equal(metadata.get("s1").updatedAt, originalUpdatedAt, "summary reconcile must not reorder sessions");
assert.equal(metadata.get("s1").listSummary.artifactCount, 3);

metadata.set("s1", {
  ...metadata.get("s1"),
  listSummary: {
    ...metadata.get("s1").listSummary,
    artifactCount: 3,
    artifactPreview: "places · places",
  },
});
const hydration = await artifacts.hydrateListSummaries({ sessionIds: ["s1"] });
assert.deepEqual(hydration, { updated: 1, sessionIds: ["s1"] });
assert.equal(metadata.get("s1").listSummary.artifactCount, 3);
assert.notEqual(metadata.get("s1").listSummary.artifactPreview, "places · places");

const beforeScheduled = metadata.get("s1").listSummary.lastText;
artifacts.scheduleListSummaryPatch("s1", { lastText: "new event", lastType: "assistant" }, { delay: 0 });
await waitFor(() => metadata.get("s1").listSummary.lastText === "new event");
assert.notEqual(metadata.get("s1").listSummary.lastText, beforeScheduled);
assert.equal(broadcasts.some(event => event.type === "sessions_changed"), true);

artifacts.scheduleListSummaryPatch("s1", { lastText: "must not land" }, { delay: 20 });
artifacts.clearListSummaryPatch("s1");
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(metadata.get("s1").listSummary.lastText, "new event");

console.log("session artifact source-of-truth tests passed");

function resourceKey(item = {}) {
  return String(item.table || item.downloadId || item.artifactId || item.filename || item.url || JSON.stringify(item));
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
