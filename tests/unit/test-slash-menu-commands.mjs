import assert from "node:assert/strict";

import {
  BUILTIN_SLASH_COMMANDS,
  createSlashMenuFeature,
  parseSlashCommandText,
} from "../../src/sidepanel/features/chat/slash-menu-feature.js";

import { createWorkspaceExtensions } from "../../src/sidepanel/features/app/workspace-extensions.js";
import { createDataReferences } from "../../src/capabilities/data/references.js";
import { createSkillReferences } from "../../src/capabilities/skills/references.js";

assert.deepEqual(
  BUILTIN_SLASH_COMMANDS.map(command => [command.kind, command.name, command.token]),
  [["command", "compact_context", "/compact"]],
);

assert.deepEqual(
  pickCommandFields(parseSlashCommandText("/compact")),
  { name: "compact_context", alias: "compact", argumentText: "" },
);
assert.deepEqual(
  pickCommandFields(parseSlashCommandText("  /压缩上下文   重点保留数据库设计和未完成事项  ")),
  {
    name: "compact_context",
    alias: "压缩上下文",
    argumentText: "重点保留数据库设计和未完成事项",
  },
);
assert.deepEqual(
  pickCommandFields(parseSlashCommandText("/COMPACT 保留代码\n以及验证结果")),
  {
    name: "compact_context",
    alias: "COMPACT",
    argumentText: "保留代码\n以及验证结果",
  },
);
assert.equal(parseSlashCommandText("/unknown some text"), null);
assert.equal(parseSlashCommandText("请执行 /compact"), null, "commands only own a whole composer submission");

const previousDocument = globalThis.document;
try {
  globalThis.document = {
    addEventListener() {},
    createElement: () => ({
      textContent: "",
      get innerHTML() { return this.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
    }),
  };
  const menu = { innerHTML: "", classList: { add() {}, remove() {} }, addEventListener() {}, querySelector() { return null; } };
  const input = { value: "/", selectionStart: 1, selectionEnd: 1, focus() {}, setSelectionRange() {} };
  const extensions = createWorkspaceExtensions(error => { throw error; });
  const controller = new AbortController();
  extensions.register({ references: [
    createDataReferences(async () => [{ name: "places", count: 2, createdAt: "2026-09-18 12:00:00" }], value => String(value).split(" ")[0]),
    createSkillReferences(async () => [
      { name: "site-guide", displayName: "站点指南", description: "说明", scope: "site", domains: ["example.com"], status: "enabled" },
      { name: "disabled", status: "disabled" },
    ], async () => ["https://example.com/"]),
    { id: "notes", label: "笔记", menuLabel: "<Note>", filterLabel: "notes", order: 30,
      list: async () => [{ kind: "notes", name: "draft", label: "Draft", title: "Draft", subtitle: "", meta: "笔记", priority: 3, search: "draft", token: "@note(draft)" }] },
  ] }, controller.signal);
  const feature = createSlashMenuFeature({ input, menu, references: extensions });
  await feature.update();
  assert.match(menu.innerHTML, /data-slash-filter="command"/u);
  assert.match(menu.innerHTML, />command: 1</u);
  assert.match(menu.innerHTML, /class="slash-kind command">命令</u);
  assert.match(menu.innerHTML, /data-slash-filter="data_store"[^>]*>data: 1</u);
  assert.match(menu.innerHTML, /data-slash-filter="skill"[^>]*>skill: 1</u);
  assert.match(menu.innerHTML, /2 行 · 2026-09-18/u);
  assert.match(menu.innerHTML, /站点技能/u);
  assert.match(menu.innerHTML, /data-slash-filter="notes"[^>]*>notes: 1</u);
  assert.match(menu.innerHTML, /&lt;Note&gt;/u, "custom source labels must remain text");
  assert.ok(menu.innerHTML.indexOf("站点指南") < menu.innerHTML.indexOf("places"), "matching site skills retain their higher priority");
  for (const [query, token] of [["places", "[data_store: places]"], ["site-guide", "[skill: site-guide]"], ["draft", "@note(draft)"]]) {
    input.value = `/${query}`;
    input.selectionStart = input.selectionEnd = input.value.length;
    await feature.update();
    assert.equal(feature.handleKeydown({ key: "Enter", preventDefault() {} }), true);
    assert.equal(input.value, token, "reference source controls its insertion token while builtins keep their original syntax");
  }
  input.value = "/";
  input.selectionStart = input.selectionEnd = 1;
  await feature.update();
  controller.abort();
  await feature.refresh();
  assert.doesNotMatch(menu.innerHTML, /data-slash-filter="(?:data_store|skill|notes)"/u);
  assert.match(menu.innerHTML, />command: 1</u, "removing capability references leaves framework commands usable");
} finally {
  globalThis.document = previousDocument;
}

console.log("slash menu command tests passed");

function pickCommandFields(command) {
  if (!command) return null;
  return {
    name: command.name,
    alias: command.alias,
    argumentText: command.argumentText,
  };
}
