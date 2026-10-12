import assert from "node:assert/strict";
import test from "node:test";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { registerTableExample } from "../fixtures/capabilities/example/table-tool.js";
import registerSkills from "../fixtures/capabilities/example/skills.js";
import metadata from "../fixtures/capabilities/example/metadata.js";
import presets from "../fixtures/capabilities/example/presets.js";
import capabilities from "../fixtures/capabilities/example/model-capabilities.js";
import { taskNoteSource } from "../fixtures/capabilities/example/context-and-observer.js";
import { createJsonDocumentCodec } from "../fixtures/capabilities/example/json-document-codec.js";
import { parseExampleTableResult } from "../fixtures/capabilities/example/result.js";

function withoutDocumentation(value) {
  if (Array.isArray(value)) return value.map(withoutDocumentation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .map(([key, field]) => [key, withoutDocumentation(field)]));
}

test("one registered tool provides localized documentation while preserving its schema, user content and cancellation", () => {
  let tool;
  registerTableExample(definition => { tool = definition; });
  const input = { title: "用户 title {count}", rows: [{ label: "用户 label", value: 12 }] };
  const read = language => withLanguage(language, () => ({
    title: tool.title, description: tool.description, parameters: tool.parameters,
    defaultResult: tool.execute({ rows: input.rows }), result: tool.execute(input),
  }));
  const zh = read("zh-CN"), en = read("en");
  assert.equal(zh.title, "示例数据");
  assert.equal(en.title, "Example data");
  assert.equal(zh.description, "展示一组带标签的数值，返回可复制的表格。");
  assert.equal(en.description, "Display labeled values as a table that can be copied.");
  for (const field of ["title", "rows"]) {
    assert.notEqual(zh.parameters.properties[field].description, en.parameters.properties[field].description);
  }
  for (const field of ["label", "value"]) {
    assert.notEqual(zh.parameters.properties.rows.items.properties[field].description,
      en.parameters.properties.rows.items.properties[field].description);
  }
  assert.deepEqual(withoutDocumentation(en.parameters), withoutDocumentation(zh.parameters));
  assert.equal(zh.defaultResult.title, "示例数据");
  assert.equal(en.defaultResult.title, "Example data");
  assert.deepEqual(zh.result, input);
  assert.deepEqual(en.result, input);
  assert.equal(parseExampleTableResult(en.result), en.result);
  assert.throws(() => tool.execute(input, AbortSignal.abort()), { name: "AbortError" });
});

test("localized skills, provider labels and source metadata preserve identifiers and original data", () => {
  let skill;
  registerSkills({ registerSkill: definition => { skill = definition; } });
  const codec = createJsonDocumentCodec(bytes => new TextDecoder().decode(bytes));
  const input = new TextEncoder().encode('{"text":"用户原文 {name}"}');
  const snapshot = language => withLanguage(language, () => ({
    skill: { name: skill.name, displayName: skill.displayName, description: skill.description,
      content: skill.content, resources: skill.resources, aliases: skill.aliases },
    metadata: metadata.tools.example_table,
    preset: presets["example-local"].label, options: presets["example-local"].modelOptions,
    modelProvider: capabilities.official["example-local"].providerLabel,
    contextTitle: taskNoteSource(async () => "original note").title,
    document: codec.parse(input),
  }));
  const zh = snapshot("zh-CN"), en = snapshot("en");
  assert.equal(zh.skill.displayName, "示例阅读指南");
  assert.equal(en.skill.displayName, "Example reading guide");
  assert.equal(en.skill.name, zh.skill.name);
  assert.deepEqual(en.skill.aliases, ["示例阅读指南", "Example reading guide"]);
  assert.deepEqual(en.skill.aliases, zh.skill.aliases);
  assert.match(en.skill.content, /references\/outline\.md/);
  assert.equal(en.skill.resources[0].path, zh.skill.resources[0].path);
  assert.notEqual(en.skill.resources[0].content, zh.skill.resources[0].content);
  assert.equal(zh.preset, "本地示例");
  assert.equal(en.preset, "Example local");
  assert.equal(en.modelProvider, en.preset);
  assert.equal(zh.modelProvider, zh.preset);
  assert.deepEqual(en.options.map(({ key, defaultValue, options }) => ({ key, defaultValue, values: options.map(option => option.value) })),
    zh.options.map(({ key, defaultValue, options }) => ({ key, defaultValue, values: options.map(option => option.value) })));
  assert.equal(zh.contextTitle, "任务笔记");
  assert.equal(en.contextTitle, "Task note");
  assert.equal(en.metadata.title, "Example data");
  assert.equal(zh.metadata.title, "示例数据");
  assert.equal(en.metadata.titleRule.values["浏览器调研示例"], "Research results");
  assert.equal(zh.metadata.titleRule.values["浏览器调研示例"], "调研结果");
  assert.equal(en.document.title, "JSON note");
  assert.equal(zh.document.title, "JSON 笔记");
  assert.deepEqual(en.document.blocks, zh.document.blocks);
  assert.equal(en.document.blocks[0].text, "用户原文 {name}");
});

test("the package result parser accepts current results without dropping fields and rejects incompatible history", () => {
  const current = { title: "用户标题", rows: [{ label: "用户标签", value: 0 }], futureField: "keep me" };
  assert.equal(parseExampleTableResult(current), current);
  assert.deepEqual(parseExampleTableResult({ title: "Empty", rows: [] }), { title: "Empty", rows: [] });
  for (const value of [undefined, null, "legacy text", [], { error: "Failed" },
    { rows: [] }, { title: 1, rows: [] }, { title: "Old", rows: [{ label: "A", value: "12" }] },
    { title: "Old", rows: [{ label: "A", value: NaN }] }, { title: "Old", rows: [{ label: "A", value: Infinity }] },
    { title: "Old", rows: [{ value: 12 }] }, { title: "Old", rows: [null] },
  ]) assert.equal(parseExampleTableResult(value), undefined);
});
