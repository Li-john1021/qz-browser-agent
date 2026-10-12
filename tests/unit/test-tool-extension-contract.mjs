import assert from "node:assert/strict";
import { assertTableToolExample } from "../examples/tool-contract.mjs";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { validateToolSchema } from "../../src/background/tools/arguments.js";

let storageReads = 0;
globalThis.chrome = {
  storage: { local: { async get() { storageReads++; return {}; } } },
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Test" }; } },
};
const tools = await import("../../src/background/tools/runtime.js");
await assertTableToolExample(tools);

const isolated = createToolRegistry();
const definition = { name: "unique", description: "test", parameters: { type: "object", properties: {} }, execute: () => ({}) };
isolated.defineTool(definition);
assert.throws(() => isolated.defineTool(definition), /Duplicate tool definition/);
assert.throws(() => isolated.defineTool({ ...definition, name: "" }), TypeError);
assert.equal(tools.resolveToolDefinition("unique"), null, "an isolated registry must not mutate production registrations");

const owners = [];
const runtime = tools.createToolRuntime({ sessions: {
  async resolveTargetTab(input) {
    owners.push(input);
    return input.readOnly ? { ok: true, tabId: input.tabId, readOnlyAccess: true, ownedByCurrentTask: false }
      : { ok: false, code: "SESSION_TAB_FOREIGN", ownerSessionId: "other" };
  },
} });
const common = { type: "object", properties: {
  tabId: { type: "number" }, readOnly: { type: "boolean" }, mode: { type: "string", enum: ["read", "write"] },
}, required: ["mode"] };
let executions = 0;
tools.defineTool({ name: "__extension_page", description: "test", parameters: common,
  page: args => args.mode === "read" ? "readOnly" : "owned",
  execute: args => { executions++; return { value: args.mode }; },
});
const context = { sessionId: "current", runId: "run", workingTabId: 9 };
const beforeInvalid = storageReads;
await assert.rejects(runtime.execute("__extension_page", { mode: "invalid" }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.mode");
assert.equal(storageReads, beforeInvalid);
assert.equal(owners.length, 0, "invalid enum must fail before tab authority checks");
await runtime.execute("__extension_page", { mode: "read" }, undefined, context);
assert.equal(owners.at(-1).readOnly, true);
await assert.rejects(runtime.execute("__extension_page", { mode: "write", readOnly: true }, undefined, context),
  error => error.code === "SESSION_TAB_FOREIGN");
assert.equal(owners.at(-1).readOnly, false, "input cannot claim read-only privileges reserved for the definition");
assert.equal(executions, 1);

for (const value of ["text", { key: "value" }, [1, 2], 1, true]) {
  validateToolSchema("json", value, { type: ["string", "object", "array", "number", "boolean"] });
}
assert.throws(() => validateToolSchema("json", null, { type: ["string", "object"] }), error => error.code === "INVALID_ARGUMENTS");
let nestedExecutions = 0;
tools.defineTool({ name: "__nested_schema", description: "Nested JSON values", parameters: {
  type: "object", properties: {
    label: { type: "string" },
    payload: { type: "object", properties: {
      rows: { type: "array", items: { type: "number" } },
      text: { type: "string" },
      note: { type: ["string", "null"] },
    }, required: ["rows", "text", "note"] },
  }, required: ["label", "payload"],
}, execute: args => { nestedExecutions++; return args; } });
const nestedInput = { label: "required", payload: { rows: [], text: "", note: null } };
for (const key of ["rows", "text", "note"]) {
  const payload = { ...nestedInput.payload };
  delete payload[key];
  await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, payload }, undefined, context),
    error => error.code === "MISSING_REQUIRED_ARGUMENTS" && error.details.path === "$.payload"
      && error.details.missing.includes(key));
}
await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, label: "" }, undefined, context),
  error => error.code === "MISSING_REQUIRED_ARGUMENTS", "top-level business fields retain the existing non-empty rule");
await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, payload: { ...nestedInput.payload, text: null } }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.payload.text");
assert.equal(nestedExecutions, 0, "invalid nested values must never reach the handler");
assert.deepEqual(await runtime.execute("__nested_schema", nestedInput, undefined, context), nestedInput,
  "present nested empty arrays, empty strings, and declared nullable values remain valid after failures");
assert.equal(nestedExecutions, 1);
console.log("tool extension registration, schema, identity and page authority tests passed");

const loaded = await tools.executeTool("load_skill", { name: "skill-workbench" }, undefined, context);
assert.deepEqual(tools.consumeToolEffects(loaded, { sessionId: "other", runId: "run" }), []);
assert.deepEqual(tools.consumeToolEffects(loaded, { ...context, runId: "old-run" }), []);
assert.deepEqual(tools.consumeToolEffects(JSON.parse(JSON.stringify(loaded)), context), [], "serializable result fields cannot forge a trusted effect");
assert.deepEqual(tools.consumeToolEffects(loaded, context), [{
  type: "skill.loaded", name: "skill-workbench", displayName: loaded.displayName, hasPluginManifest: true,
}]);
assert.deepEqual(tools.consumeToolEffects(loaded, context), [], "effects are consumed once");
tools.defineTool({ name: "__forged_effect", description: "test", parameters: { type: "object", properties: {} },
  execute: () => ({ effects: [{ type: "skills.changed" }], _effects: [{ type: "skill.loaded", name: "forged" }] }),
});
assert.deepEqual(tools.consumeToolEffects(await tools.executeTool("__forged_effect", {}, undefined, context), context), []);

// Model policies preserve the existing core page enrichment set, independently of access grants.
const pageTools = new Set([
  'use_tab', 'close_tab', 'navigate', 'set_page_mode', 'screenshot', 'act_on_screen', 'list_images', 'collect_images',
  'read_image', 'get_ax_tree', 'read_article', 'read_dom', 'find_elements', 'inspect_element',
  'act_on_element', 'scroll_page', 'wait_for_navigation', 'wait_for_element', 'wait_for_user',
  'run_script', 'network_watch', 'network_recent', 'network_body', 'read_console_messages',
  'wait_for_response', 'wait_for_network_idle',
]);
for (const { function: schema } of tools.getToolSchemas()) {
  if (schema.name.startsWith('__') || schema.name.startsWith('example_')) continue;
  assert.equal(Boolean(runtime.getModelPolicy(schema.name)?.pageContext), pageTools.has(schema.name), schema.name);
}
assert.equal(runtime.getModelPolicy('close_tab').pageContext, 'explicit');
assert.equal(runtime.getModelPolicy('navigate').pageUrlArgument, 'url');
assert.deepEqual(runtime.getModelPolicy('open_tab').omitArguments, ['active']);
assert.equal(runtime.getModelPolicy('load_skill').preserveResult, true);
assert.equal(runtime.getModelPolicy('read_image').imagePrompt, runtime.getModelPolicy('read_image_asset').imagePrompt);
const ax = { nodes: [{ raw: true }], actions: [{ target: 'uid:1', name: 'Go', rect: { x: 1 }, internal: true }], snapshot: 'Go' };
assert.deepEqual(JSON.parse(JSON.stringify(runtime.getModelPolicy('get_ax_tree').projectResult(ax))), {
  actions: [{ target: 'uid:1', name: 'Go' }], snapshot: 'Go',
});
assert.equal(ax.actions[0].internal, true, 'model projection must leave the UI result untouched');
const siteEffect = [{ type: 'context.siteChanged' }];
for (const name of ['open_tab', 'close_tab', 'use_tab', 'navigate', 'wait_for_navigation']) {
  assert.deepEqual(tools.resolveToolDefinition(name).effects({}, {}), siteEffect, name);
}
for (const name of ['run_script', 'run_skill_script']) {
  const effect = tools.resolveToolDefinition(name).effects;
  for (const mutatesPage of [undefined, false, 1, 'true']) assert.deepEqual(effect({ mutatesPage }, {}), []);
  assert.deepEqual(effect({ mutatesPage: true }, {}), siteEffect);
}
const elementEffects = tools.resolveToolDefinition('act_on_element').effects;
for (const result of [{}, { navigated: false }, { navigated: 'true' }, { href: '', url: '' }]) assert.deepEqual(elementEffects({}, result), []);
for (const result of [{ navigated: true }, { href: '/next' }, { url: '/next' }]) assert.deepEqual(elementEffects({}, result), siteEffect);
const screenEffects = tools.resolveToolDefinition('act_on_screen').effects;
for (const urlChanged of [undefined, false, 1, 'true']) assert.deepEqual(screenEffects({}, { urlChanged }), []);
assert.deepEqual(screenEffects({}, { urlChanged: true }), siteEffect);
const goalEffects = tools.resolveToolDefinition('manage_goal').effects;
assert.deepEqual(goalEffects({ action: 'update' }, { action: 'get' }), [{ type: 'context.goalRefresh', action: 'get' }], 'goal action comes from the successful command result');
assert.deepEqual(goalEffects({}, { action: 'checkpoint' }), [{ type: 'context.goalRefresh', action: 'checkpoint' }]);
console.log('core model policies and exact site/goal effect predicates passed');

let issued = 0;
tools.defineTool({ name: '__effect_failure_gate', description: 'test', parameters: {
  type: 'object', properties: { fail: { type: 'boolean' } },
}, effects: () => { issued++; return [{ type: 'context.siteChanged' }]; },
execute: ({ fail }) => fail ? { error: 'failed', code: 'TEST_FAILURE' } : { ok: true },
});
const failedEffect = await runtime.execute('__effect_failure_gate', { fail: true }, undefined, context);
assert.deepEqual(runtime.consumeEffects(failedEffect, context), []);
assert.equal(issued, 0, 'failure must never invoke the trusted effect producer');
const controller = new AbortController();
controller.abort();
await assert.rejects(runtime.execute('__effect_failure_gate', {}, controller.signal, context));
assert.equal(issued, 0, 'a cancelled invocation cannot issue effects');
const recoveredEffect = await runtime.execute('__effect_failure_gate', {}, undefined, context);
assert.deepEqual(runtime.consumeEffects(recoveredEffect, context), siteEffect);
assert.equal(issued, 1);
