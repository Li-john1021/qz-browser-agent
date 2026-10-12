import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { findBuiltinSkill } from "../../src/shared/skills/builtin-skills.js";
import { parseSkillManifest, findSkillManifestResource } from "../../src/shared/skills/skill-manifest.js";
import { createRunScriptBridge } from "../../src/background/tools/run-script-bridge.js";
import { clearTraceLog, getTraceLog } from "../../src/background/trace.js";

globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Page" }; } },
};
const tools = await import("../../src/background/tools/runtime.js");
const context = { sessionId: "session", runId: "run", workingTabId: 31 };
const scriptContext = { ...context, source: "run_script", senderTabId: 31, runScriptToolDepth: 0 };
const controller = new AbortController();
let currentRun = true;
const targets = [];
const runtime = tools.createToolRuntime({ sessions: {
  async resolveTargetTab(input) {
    targets.push(input);
    return input.tabId === 99 ? { ok: false, code: "SESSION_TAB_FOREIGN" } : { ok: true, tabId: input.tabId };
  },
} });
const bridge = createRunScriptBridge({
  supervisor: { isRunCurrent: () => currentRun, hasAgent: () => true, getAbortSignal: () => controller.signal },
  getRuntime: () => ({ status: "running", workingTabId: 31 }),
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  toolRuntime: runtime,
  collectArtifacts: () => [],
});
const nested = (toolName, args = {}, tabId = 31) => bridge.handleToolCall({ ...context, toolName, args }, { tab: { id: tabId } });

test("a newly named tool declares unload behavior once for direct script and forwarded host execution", async () => {
  let calls = 0;
  const behavior = { mayUnloadPage: args => args.action === "leave" };
  tools.defineTool({ name: "__custom_page_action", description: "Test", behavior, page: "owned", parameters: {
    type: "object", properties: { action: { type: "string", enum: ["stay", "leave"] }, tabId: { type: "number" } }, required: ["action"],
  }, execute: () => { calls++; return { value: calls }; } });
  behavior.mayUnloadPage = false;
  assert.ok(Object.isFrozen(runtime.resolveDefinition("__custom_page_action").behavior));
  const before = targets.length;
  assert.equal((await nested("__custom_page_action", { action: "invalid" })).code, "INVALID_ARGUMENTS");
  assert.equal(targets.length, before, "invalid arguments must fail before target ownership work");
  const denied = await nested("__custom_page_action", { action: "leave" });
  assert.equal(denied.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
  assert.equal(denied.details.targetTabId, 31);
  assert.equal(calls, 0);
  await assert.rejects(runtime.execute("__custom_page_action", { action: "leave" }, undefined,
    { ...scriptContext, source: "plugin_host" }), { code: "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED" });
  assert.equal((await nested("__custom_page_action", { action: "leave", tabId: 99 })).code, "SESSION_TAB_FOREIGN");
  assert.equal(calls, 0, "lifecycle policy cannot grant ownership");
  assert.equal((await nested("__custom_page_action", { action: "stay" })).ok, true);
  assert.equal((await nested("__custom_page_action", { action: "leave", tabId: 32 })).ok, true);
  await runtime.execute("__custom_page_action", { action: "leave" }, undefined, { ...context, senderTabId: 31 });
  assert.equal(calls, 3, "ordinary calls and other owned tabs retain their established behavior");
});

test("built-in unload declarations retain navigation, closing, click, submit and key protection", async () => {
  for (const [name, args] of [
    ["navigate", { url: "https://example.test/next" }],
    ["close_tab", { tabId: 31 }],
    ["act_on_element", { target: "css:button", action: "click" }],
    ["act_on_element", { target: "uid:unknown", action: "click" }],
    ["act_on_element", { target: "css:input", action: "fill", value: "search", submit: true }],
    ...["Enter", "Return", "Space"].map(key => ["act_on_element", { target: "css:input", action: "press", key }]),
  ]) {
    const result = await nested(name, args);
    assert.equal(result.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED", `${name} ${JSON.stringify(args)}`);
    assert.equal(result.details.sourceTabId, 31);
  }
  const policy = runtime.resolveDefinition("act_on_element").behavior.mayUnloadPage;
  assert.equal(policy({ action: "press", value: "Enter" }), true);
  for (const args of [{ action: "fill", submit: false }, { action: "press", key: "Tab" }, { action: "check" }, { action: "scroll" }]) {
    assert.equal(policy(args), false);
  }
});

test("new observation tools promote images only through trusted definitions and preserve cancellation", async () => {
  let calls = 0;
  const image = "data:image/png;base64,b2JzZXJ2YXRpb24=";
  const parameters = { type: "object", properties: { observe: { type: "boolean" } } };
  const execute = () => { calls++; return { _image: image, _imageDetail: "high", _display: { image }, behavior: { nestedObservation: true } }; };
  tools.defineTool({ name: "__custom_observe", description: "Test", parameters,
    behavior: { nestedObservation: args => args.observe === true }, execute });
  tools.defineTool({ name: "__ordinary_image", description: "Test", parameters, execute });
  const promoted = await nested("__custom_observe", { observe: true });
  assert.deepEqual(promoted.observation, { _image: image, _imageDetail: "high" });
  assert.equal(promoted.result._image, undefined);
  assert.equal(promoted.result._display, undefined);
  for (const [name, args] of [["__custom_observe", { observe: false }], ["__ordinary_image", { observe: true }]]) {
    const result = await nested(name, args);
    assert.equal(result.observation, undefined, "an ordinary result cannot declare its own observation role");
    assert.equal(result.result._image, image);
  }
  currentRun = false;
  assert.equal((await nested("__custom_observe", { observe: true })).code, "RUN_STOPPED");
  currentRun = true;
  controller.abort();
  assert.equal((await nested("__custom_observe", { observe: true })).code, "RUN_STOPPED");
  assert.equal(calls, 3, "stale and cancelled runs never invoke the tool");
});

test("external plugins cannot declare behavior, while trusted host aliases inherit their core target", () => {
  const registry = createToolRegistry();
  registry.defineTool({ ...tools.resolveToolDefinition("manage_settings"),
    behavior: { nestedObservation: true, mayUnloadPage: true },
  });
  const toolRegistrySnapshot = registry.snapshot();
  const core = toolRegistrySnapshot.get("manage_settings");
  assert.throws(() => { core.behavior = {}; }, TypeError, "registered behavior remains immutable");
  const skill = findBuiltinSkill("qingzhou-management");
  const plugin = parseSkillManifest(findSkillManifestResource(skill.resources).content, skill).plugin;
  const tool = plugin.tools.find(item => item.localName === "manage_settings");
  const resolve = plugin => runtime.resolveDefinition(tool.name, { toolRegistrySnapshot, skillToolRegistrySnapshot: {
    plugins: [plugin], toolIndex: new Map([[tool.name, { plugin, tool }]]),
  } });
  assert.equal(resolve(plugin).behavior, core.behavior);
  for (const untrusted of [structuredClone(plugin), { ...plugin, skillBuiltin: false }, { ...plugin, skillSource: "local" }, { ...plugin, id: "external-plugin" }]) {
    assert.equal(resolve(untrusted).behavior, undefined, "plugin declarations must not cross the trusted behavior boundary");
  }
});

test("custom timeout diagnostic declarations retain the runtime's abort signal and trace fields", async () => {
  let signal;
  await clearTraceLog();
  tools.defineTool({ name: "__custom_timeout", description: "Test", parameters: { type: "object", properties: {} }, timeout: 5,
    behavior: { timeoutTrace: "custom_action_trace" },
    execute: (_args, value) => { signal = value; return new Promise(() => {}); },
  });
  await assert.rejects(runtime.execute("__custom_timeout", {}, undefined, context), { code: "TOOL_TIMEOUT" });
  assert.equal(signal.aborted, true);
  assert.ok((await getTraceLog()).some(line => line.includes("custom_action_trace") && line.includes("phase=tool.timeout")
    && line.includes("session=session") && line.includes("run=run")));
});
