import assert from "node:assert/strict";
import test from "node:test";
import { formatActionLabel, formatToolActionTitle } from "../../src/shared/tools/tool-metadata.js";

test("data action titles preserve every established read/write and fallback label", () => {
  const cases = [
    ["create_table", "创建数据表"], ["delete", "删除数据行"], ["add_column", "新增字段"],
    ["rename_column", "重命名字段"], ["delete_column", "删除字段"],
    ...["upsert", "insert", "update", "replace", "set", "clear"].map(action => [action, "写入数据表"]),
    ...["query", "list", "get", "read"].map(action => [action, "读取数据表"]),
    ["tables", "处理数据表"], ["schema", "处理数据表"], ["unknown", "处理数据表"], ["", "处理数据表"],
  ];
  for (const [action, title] of cases) {
    assert.equal(formatToolActionTitle("data_store", { action }), title, action);
    assert.equal(formatToolActionTitle("data_store", { action: ` ${action.toUpperCase()} ` }), title, action);
  }
  assert.equal(formatToolActionTitle({ name: "data_alias", capabilityId: "data_store", title: "别名标题" }, {}), "处理数据表");
});

test("model, guardrail and Skill settings retain their own titles and shared action fallbacks", () => {
  for (const [name, action, title] of [
    ["manage_settings", "get", "读取设置"], ["manage_guardrails", "get", "读取安全策略"],
    ["manage_skill_settings", "get", "读取 Skill 配置"], ["manage_skill_settings", "list", "读取 Skill 配置"],
    ["manage_skill_settings", "update", "更新 Skill 配置"],
    ...["manage_settings", "manage_guardrails", "manage_skill_settings"].map(name => [name, "reorder", "调整安全策略"]),
    ["manage_settings", "update_config", "更新模型设置"], ["manage_settings", "list_models", "查看模型列表"],
    ["manage_settings", "apply_preset", "应用模型预设"], ["manage_settings", "delete_preset", "删除模型预设"],
    ["manage_guardrails", "add_rule", "添加访问规则"], ["manage_guardrails", "remove_rule", "移除访问规则"],
    ["manage_guardrails", "add_rate_limit", "添加站点流控"], ["manage_guardrails", "remove_rate_limit", "移除站点流控"],
  ]) {
    assert.equal(formatToolActionTitle(name, { action: ` ${action.toUpperCase()} ` }), title, `${name}.${action}`);
  }
  for (const name of ["manage_settings", "manage_guardrails", "manage_skill_settings"]) {
    assert.equal(formatToolActionTitle({ name: "settings_alias", capabilityId: name, title: "别名标题" }, { action: "unknown" }), "别名标题");
  }
});

test("screen actions keep scoped labels without changing generic verbs or case sensitivity", () => {
  for (const [action, title] of [
    ["click", "点击页面"], ["double_click", "双击页面"], ["long_press", "长按页面"], ["hover", "悬停页面"],
    ["type", "输入文本"], ["press", "按下按键"], ["scroll", "滚动页面"], ["drag", "拖动页面"],
  ]) {
    assert.equal(formatActionLabel(` ${action} `, "act_on_screen"), title);
    assert.equal(formatToolActionTitle({ name: "screen_alias", capabilityId: "act_on_screen" }, { action: ` ${action} ` }), title);
  }
  assert.equal(formatActionLabel("click"), "点击");
  assert.equal(formatToolActionTitle("act_on_screen", { action: "CLICK" }), "操作页面");
  assert.equal(formatToolActionTitle("act_on_screen", { action: "delete" }), "删除");
});

test("network request/response titles retain exact request matching and fixed response fallback", () => {
  assert.equal(formatToolActionTitle("network_body", { bodyType: "request" }), "读取请求体");
  for (const bodyType of [undefined, null, "response", "unknown", "REQUEST", " request ", ["request"], { request: true }]) {
    assert.equal(formatToolActionTitle("network_body", { bodyType }), "读取响应体");
    assert.equal(formatToolActionTitle({ name: "network_alias", capabilityId: "network_body", title: "别名标题" }, { bodyType }), "读取响应体");
  }
});

test("unknown actions cannot resolve inherited JavaScript object members as labels", () => {
  for (const action of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(formatActionLabel(action), "");
    assert.equal(formatActionLabel(action, "act_on_screen"), "");
    assert.equal(formatToolActionTitle("act_on_screen", { action }), "操作页面");
    assert.equal(formatToolActionTitle("data_store", { action }), "处理数据表");
    assert.equal(formatToolActionTitle("manage_settings", { action }), "管理模型设置");
    assert.equal(formatToolActionTitle("network_body", { bodyType: action }), "读取响应体");
  }
});
