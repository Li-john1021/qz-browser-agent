import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { capabilityLocaleAssets } from "../../scripts/capability-locales.mjs";
import packs from "../../src/capabilities/i18n/locales.js";
import { chromeMessageId, decodeChromeMessage } from "../../src/shared/i18n/definition.js";
import { backendMessages } from "../../src/shared/i18n/backend-messages.js";
import { createSessionArtifacts } from "../../src/background/session/artifacts.js";
import { normalizeSessionResourceArtifact } from "../../src/shared/session/session-resource-ledger.js";

const source = resolve("src");
const assets = capabilityLocaleAssets(source).assets;
const transcript = [{
  type: "tool", name: "fixture_artifacts", endedAt: "2026-09-20 12:00:00",
  result: { artifacts: [
    { type: "data", table: "photos", title: "用户图集", kind: "image_collection", totalRows: 2 },
    { type: "data", table: "rows", title: "用户表", totalRows: 1234, columns: ["原始字段"] },
    { type: "data", table: "empty", title: "空表", totalRows: 0 },
    { type: "file", filename: "用户文件.txt", downloadId: "7", artifactId: "artifact-1", size: 42 },
  ] },
}];
const ledger = [
  // The ledger can enrich a transcript item without carrying its image kind.
  { type: "data", table: "photos", title: "用户图集", kindLabel: "数据表", totalRows: 3 },
  { type: "data", table: "legacy", title: "旧图集", kindLabel: "图集", totalRows: 1 },
  { type: "imageCollection", table: "typed", title: "类型图集", kindLabel: "数据表", totalRows: 1 },
  { type: "data", kind: "data_table", table: "plain", title: "类型表", kindLabel: "图集", totalRows: 1 },
  normalizeSessionResourceArtifact({ type: "data", table: "stored-photos", title: "已存图集", kindLabel: "画像コレクション", rowCount: 2 }, {
    sessionId: "s1", sourceTool: "collect_images",
  }),
];
const originalTranscript = structuredClone(transcript);
const originalLedger = structuredClone(ledger);
const artifacts = createSessionArtifacts({
  sessionRepository: { updateMetadata: async () => { throw new Error("A read must not persist localized text"); } },
  getSessions: async () => ({}),
  normalizeSessionId: value => String(value || "").trim(),
  nowBeijingDateTime: () => "2026-09-20 12:00:00",
  resolveSessionArtifactTranscript: async () => transcript,
  collectRunScriptToolArtifacts: () => [],
  getToolIdentity: name => ({ capabilityId: name }),
  listTables: async () => [],
  listResources: async () => ledger,
});

async function inPack(pack, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const messages = JSON.parse(assets.get(resolve(source, `_locales/${pack.chromeLocale}/messages.json`)));
  const message = key => decodeChromeMessage(messages[chromeMessageId(`backend.${key}`)])
    ?? backendMessages.messages[key][pack.language]
    ?? backendMessages.messages[key].en;
  const expected = (key, count) => message(key).replace("{count}", new Intl.NumberFormat(pack.language).format(count));
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: {
    getUILanguage: () => pack.language,
    getMessage: key => decodeChromeMessage(messages[key]) || "",
  } } });
  try { return await run(expected); }
  finally { if (previous) Object.defineProperty(globalThis, "chrome", previous); else delete globalThis.chrome; }
}

for (const pack of packs) test(`${pack.language}: artifact snapshots and model context use the selected language`, async () => {
  await inPack(pack, async expected => {
    const snapshot = await artifacts.collect("s1");
    assert.equal(snapshot.total, 8);
    assert.equal(snapshot.summary.note, expected("artifact.indexNote"));
    assert.deepEqual(snapshot.imageCollections.map(item => item.table).sort(), ["legacy", "photos", "stored-photos", "typed"]);
    for (const item of snapshot.imageCollections) {
      assert.equal(item.kindLabel, expected("artifact.imageCollection"));
      assert.equal(item.summary, expected("artifact.imageSummary", item.totalRows));
    }
    for (const item of snapshot.dataTables) {
      assert.equal(item.kindLabel, expected("artifact.dataTable"));
      assert.equal(item.summary, expected(item.totalRows ? "artifact.tableSummary" : "artifact.dataTable", item.totalRows));
    }
    assert.equal(snapshot.dataTables.find(item => item.table === "rows").title, "用户表");
    assert.deepEqual(snapshot.dataTables.find(item => item.table === "rows").columns, ["原始字段"]);
    assert.equal(snapshot.files[0].filename, "用户文件.txt");
    assert.equal(snapshot.files[0].kindLabel, expected("artifact.file"));
    assert.equal(snapshot.files[0].downloadId, "7");
    assert.equal(snapshot.files[0].artifactId, "artifact-1");

    const context = await artifacts.collectContext(transcript);
    assert.equal(context.summary.note, expected("artifact.contextNote"));
    assert.equal(context.imageCollections[0].summary, expected("artifact.imageSummary", 2));
    assert.equal(context.imageCollections[0].usage, expected("artifact.imageUsage"));
    for (const key of ["dataTables", "rowIds", "assetIds", "sourceRef", "image"]) {
      assert.ok(context.imageCollections[0].usage.includes(key), `${pack.language}: preserve ${key}`);
    }
    for (const item of context.dataTables) {
      assert.equal(item.summary, expected(item.totalRows ? "artifact.tableSummary" : "artifact.dataTable", item.totalRows));
      assert.equal(item.usage, expected("artifact.tableUsage"));
    }
    assert.equal(context.files[0].usage, expected("artifact.fileUsage"));
    assert.deepEqual(transcript, originalTranscript);
    assert.deepEqual(ledger, originalLedger);
  });
});

test("the same existing artifacts can be read in another language without changing identity or history", async () => {
  const collect = language => inPack(packs.find(pack => pack.language === language), () => artifacts.collect("s1"));
  const chinese = await collect("zh-CN");
  const english = await collect("en");
  const japanese = await collect("ja");
  const facts = snapshot => snapshot.items.map(({ kindLabel, summary, ...item }) => item);
  assert.deepEqual(facts(chinese), facts(english));
  assert.deepEqual(facts(english), facts(japanese));
  assert.equal(chinese.imageCollections[0].kindLabel, "图集");
  assert.equal(english.imageCollections[0].kindLabel, "Image collection");
  assert.equal(japanese.imageCollections[0].kindLabel, "画像コレクション");
  assert.equal(english.imageCollections.find(item => item.table === "photos").summary, "Image collection · Images/rows: 3");
  assert.equal(english.dataTables.find(item => item.table === "rows").summary, "Data table · Rows: 1,234");
  assert.deepEqual(transcript, originalTranscript);
  assert.deepEqual(ledger, originalLedger);
});

test("model context classifies stable artifact types before interpreting legacy display labels", async () => {
  const context = await artifacts.collectContext([{ type: "tool", name: "custom", result: { artifacts: [
    { type: "imageCollection", kindLabel: "数据表", table: "photos", totalRows: 1 },
    { type: "dataTable", kindLabel: "图集", table: "rows", totalRows: 1 },
  ] } }]);
  assert.equal(context.imageCollections[0].table, "photos");
  assert.equal(context.dataTables[0].table, "rows");
  assert.equal(context.imageCollections.length, 1);
  assert.equal(context.dataTables.length, 1);
});
