import assert from "node:assert/strict";
import test from "node:test";
import { parseImportText } from "../../src/capabilities/data/workspace/data-import-parser.js";
import { createDataGridSortProfiles } from "../../src/capabilities/data/workspace/data-grid-sort-profiles.js";
import { createDataReferences } from "../../src/capabilities/data/references.js";
import { formatSessionArgsPreview } from "../../src/capabilities/sessions/presentation.js";
import { registerSessionTools } from "../../src/capabilities/sessions/tools.js";
import { createArtifactModel } from "../../src/capabilities/sessions/artifacts/artifact-model.js";

function useLanguage(context, language) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: { getUILanguage: () => language } } });
  context.after(() => previous ? Object.defineProperty(globalThis, "chrome", previous) : delete globalThis.chrome);
}

test("short type names preserve image collections from older localized summaries", context => {
  useLanguage(context, "en-US");
  const model = createArtifactModel({ request: async () => ({}) });
  for (const kindLabel of ["Image collection", "画像コレクション", "Collection d’images", "Подборка изображений", "مجموعة صور"]) {
    const source = { id: "legacy-collection", kindLabel, title: "Original title", count: 2 };
    const item = model.normalizeArtifactSummaryDataItem(source);
    assert.equal(item.kind, "image_collection", kindLabel);
    assert.equal(item.kindLabel, "Image");
    assert.equal(item.title, source.title);
    assert.equal(item.count, 2);
    assert.equal(source.kindLabel, kindLabel, "reading must not rewrite history");
  }
});

for (const language of ["zh-CN", "en-US"]) {
  test(`Data import errors follow ${language} without translating row content`, context => {
    useLanguage(context, language);
    assert.throws(() => parseImportText(""), { message: language === "zh-CN" ? "导入内容为空" : "Nothing to import" });
    const result = parseImportText("产品,说明\n轻舟,保存", "sample.csv");
    assert.equal(result[0].产品, "轻舟");
    assert.equal(result[0].说明, "保存");
  });

  test(`Data sort labels follow ${language} while Chinese numeric units retain their meaning`, context => {
    useLanguage(context, language);
    const profiles = createDataGridSortProfiles({ getCurrentTable: () => "table", getProfiles: () => new Map(), formatCellValue: String });
    const money = profiles.inferProfiles([{ amount: "2万元" }, { amount: "3亿元" }], ["amount"]).get("amount");
    assert.equal(money.kind, "money");
    assert.equal(money.label, language === "zh-CN" ? "金额" : "Currency");
    assert.deepEqual(money.parse("2万元"), { valid: true, key: 20000 });
  });

  test(`Data reference metadata follows ${language} while table names remain user content`, async context => {
    useLanguage(context, language);
    const references = createDataReferences(async () => [{ name: "保存", count: 3, createdAt: "2026-01-01" }], () => "2026-01-01");
    const [item] = await references.list(new AbortController().signal);
    assert.equal(item.label, "保存");
    assert.equal(item.name, "保存");
    assert.equal(item.subtitle, language === "zh-CN" ? "3 行 · 2026-01-01" : "Rows: 3 · 2026-01-01");
  });
}

test("Session previews translate their wrapper and preserve the user's prompt", context => {
  useLanguage(context, "en-US");
  const output = formatSessionArgsPreview({ action: "create", prompt: "保存这些内容，不要翻译" });
  assert.match(output, /保存这些内容，不要翻译/u);
  assert.equal(formatSessionArgsPreview({ action: "wait", sessionIds: ["one", "two"] }).includes("Tasks: 2"), true);
  assert.equal(formatSessionArgsPreview({ action: "wait", sessionIds: ["one"] }).includes("Tasks: 1"), true);
});

test("Legacy Chinese image-collection labels retain their kind in an English UI", async context => {
  useLanguage(context, "en-US");
  const model = createArtifactModel({ request: async () => ({ artifacts: {
    dataTables: [{ table: "保存", kindLabel: "图集", rowCount: 1 }],
  } }) });
  const summary = await model.collectSessionArtifactsWithRuntime("session", []);
  assert.equal(summary.data[0].title, "保存");
  assert.equal(summary.data[0].kindLabel, "Image");
  assert.equal(summary.data[0].meta, "Images: 1");
});

for (const language of ["zh-CN", "en-US"]) {
  test(`Legacy collect_images metadata follows ${language} without rewriting third-party text`, context => {
    useLanguage(context, language);
    const artifact = { type: "data", kindLabel: "图集", table: "照片", title: "照片", rowCount: 2, meta: "2 张图片", score: 3 };
    const model = createArtifactModel({ request: async () => ({}) });
    const summary = model.collectSessionArtifacts("legacy-media", [
      { type: "tool", name: "collect_images", args: { table: "照片" }, result: { table: "照片", kind: "image_collection", totalRows: 2, artifacts: [artifact] } },
      { type: "tool", name: "third_party_collection", args: {}, result: { artifacts: [{ ...artifact, table: "第三方", title: "第三方" }] } },
    ]);
    const media = summary.data.find(item => item.title === "照片");
    assert.equal(media.kind, "image_collection");
    assert.equal(media.kindLabel, language === "zh-CN" ? "图集" : "Image");
    assert.equal(media.meta, language === "zh-CN" ? "2 张" : "Images: 2");
    assert.equal(summary.data.find(item => item.title === "第三方").meta, "2 张图片", "the same text from a third-party artifact is preserved");
    assert.equal(artifact.meta, "2 张图片", "legacy transcript facts are not mutated");
    assert.equal(artifact.kind, undefined);
  });

  test(`Artifact product labels follow ${language}, preserving source titles and descriptions`, context => {
    useLanguage(context, language);
    const model = createArtifactModel({ request: async () => ({}) });
    const summary = model.buildArtifactSummaryFromRuntimeArtifacts("session", {
      imageCollections: [{ table: "照片", kindLabel: "旧标签", totalRows: 2 }],
      dataTables: [{ type: "dataTable", table: "数据", kindLabel: "图集", totalRows: 3, meta: "用户描述：保留原文" }],
      files: [{ filename: "报告.txt", kindLabel: "文件", downloadId: 7 }],
    });
    const image = summary.data.find(item => item.table === "照片");
    const data = summary.data.find(item => item.table === "数据");
    assert.equal(image.kind, "image_collection");
    assert.equal(image.kindLabel, language === "zh-CN" ? "图集" : "Image");
    assert.equal(image.meta, language === "zh-CN" ? "2 张" : "Images: 2");
    assert.equal(image.title, "照片");
    assert.equal(data.kind, "data_table", "stable type wins over stale labels");
    assert.equal(data.kindLabel, language === "zh-CN" ? "数据表" : "Data");
    assert.equal(data.meta, "用户描述：保留原文");
    assert.equal(summary.files[0].title, "报告.txt");
    assert.equal(model.normalizeArtifactSummaryFileItem({ ...summary.files[0], kindLabel: "旧标签" }).kindLabel, language === "zh-CN" ? "文件" : "File");
    const normalized = model.normalizeArtifactSummaryDataItem({ id: "legacy", kindLabel: "图集" });
    assert.equal(normalized.kind, "image_collection", "legacy kinds survive subsequent translated label changes");
    assert.equal(model.normalizeArtifactSummaryDataItem({ ...normalized, kindLabel: "別のラベル" }).kindLabel, language === "zh-CN" ? "图集" : "Image");
  });
}

test("Session error codes remain stable when the human-readable message changes", async context => {
  useLanguage(context, "en-US");
  const tools = new Map();
  class ToolExecutionError extends Error { constructor(code, message) { super(message); this.code = code; } }
  registerSessionTools({ registerTool: value => tools.set(value.name, value), ToolExecutionError, secondsToMs: value => value * 1000, getToolRuntimeDependencies: () => ({ sessions: {} }) });
  await assert.rejects(tools.get("manage_sessions").execute({ action: "stop" }, undefined, { sessionId: "parent" }), error => {
    assert.match(error.message, /Specify the target task/);
    assert.equal(error.code, "MISSING_SESSION_ID");
    return true;
  });
});
