import assert from "node:assert/strict";
import { assertScriptPageLifecycle } from "../../src/background/tools/behavior.js";
import {
  createRunScriptArtifactCollector,
  createRunScriptBridge,
} from "../../src/background/tools/run-script-bridge.js";

const appended = [];
const refreshes = [];
const executions = [];
const schemaContexts = [];
const nestedResults = [];
let readyCount = 0;
const controller = new AbortController();
const toolRegistrySnapshot = Object.freeze({ language: "en", marker: "frozen core declarations" });
const skillToolRegistrySnapshot = { version: 7, plugins: [], toolIndex: new Map() };
const collector = createRunScriptArtifactCollector({
  getToolIdentity: name => ({ capabilityId: name === "store_alias" ? "data_store" : name }),
});
const supervisor = {
  isRunCurrent: (_sessionId, runId) => runId === "run-current",
  hasAgent: () => true,
  getAbortSignal: () => controller.signal,
};
const toolRuntime = {
  resolveDefinition(name) {
    return { name, behavior: {
      mayUnloadPage: name === "navigate",
      nestedObservation: name === "screenshot" || (name === "act_on_screen" ? args => args.returnScreenshot === true : false),
    } };
  },
  getSchemas: context => {
    schemaContexts.push(context);
    return [{
      function: {
        name: "read_dom",
        description: "Read DOM",
        parameters: { type: "object" },
      },
    }];
  },
  async execute(name, args, _signal, context) {
    assertScriptPageLifecycle(this.resolveDefinition(name), args, context);
    executions.push({ name, args, context });
    if (name === "returns_error") return { ok: false, code: "EXPECTED_FAILURE", error: "failed" };
    if (name === "throws") throw Object.assign(new Error("exploded"), { code: "EXPLODED" });
    if (name === "store_alias") return { table: args.table, inserted: 2, totalRows: 2 };
    if (name === "act_on_screen") {
      return {
        feedbackAvailable: args.returnScreenshot === true,
        coordinateBasisReady: true,
        returnScreenshot: args.returnScreenshot,
        ...(args.returnScreenshot === true ? {
          _image: "data:image/jpeg;base64,YWN0aW9u",
          _imageDetail: "high",
        } : {}),
        _display: {
          type: "imageWithAction",
          beforeImage: "data:image/jpeg;base64,YmVmb3Jl",
          afterImage: "data:image/jpeg;base64,YWZ0ZXI=",
        },
      };
    }
    if (name === "screenshot") {
      return {
        _image: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
        _imageDetail: "high",
        screenshotId: "screen-latest",
      };
    }
    if (name === "read_image") {
      return {
        _image: "data:image/png;base64,cmVhZC1pbWFnZQ==",
        description: "image payload owned by read_image",
      };
    }
    return { value: 1 };
  },
};
const bridge = createRunScriptBridge({
  ready: async () => { readyCount += 1; },
  normalizeSessionId: value => String(value || "").trim(),
  supervisor,
  getRuntime: () => ({
    status: "running",
    workingTabId: 31,
    workingUrl: "https://example.test/current",
    workingTab: { id: 31, url: "https://example.test/current" },
    visitedTaskSites: [{ id: 31, url: "https://example.test/current" }],
    loadedPluginSkillNames: ["runtime-skill"],
  }),
  isTerminalRuntimeForRun: runtime => runtime.status === "aborted",
  canManageSessions: async () => true,
  buildRunProfile: async input => ({ session: input }),
  getRunToolContext: async () => ({
    dynamicContext: { marker: "agent", pageUrl: "https://stale.test/" },
    loadedPluginSkillNames: ["agent-skill"],
    runProfile: { id: "frozen-profile" },
    skillToolRegistrySnapshot,
    toolRegistrySnapshot, language: "en",
  }),
  applyNestedToolResult: async value => {
    nestedResults.push(value);
    return true;
  },
  toolRuntime,
  collectArtifacts: collector,
  appendArtifacts: async value => appended.push(value),
  scheduleArtifactRefresh: (...args) => refreshes.push(args),
});

const missing = await bridge.handleToolCall({ sessionId: "s1", runId: "run-current" });
assert.equal(missing.ok, false);
assert.equal(missing.code, "MISSING_TOOL_NAME");

const listed = await bridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(listed.ok, true);
assert.deepEqual(listed.result.tools, [{
  name: "read_dom",
  description: "Read DOM",
  parameters: { type: "object" },
}]);
assert.equal(schemaContexts.at(-1).runProfile.id, "frozen-profile");
assert.equal(schemaContexts.at(-1).skillToolRegistrySnapshot, skillToolRegistrySnapshot);
assert.equal(schemaContexts.at(-1).toolRegistrySnapshot, toolRegistrySnapshot);
assert.equal(schemaContexts.at(-1).language, "en");
assert.equal(schemaContexts.at(-1).dynamicContext.pageUrl, "https://example.test/current");
assert.deepEqual(schemaContexts.at(-1).loadedPluginSkillNames, ["agent-skill", "runtime-skill"]);

const tooDeep = await bridge.handleToolCall({
  toolName: "read_dom",
  sessionId: "s1",
  runId: "run-current",
  depth: 4,
});
assert.equal(tooDeep.code, "RUN_SCRIPT_TOOL_DEPTH_EXCEEDED");

const unload = await bridge.handleToolCall({
  toolName: "navigate",
  sessionId: "s1",
  runId: "run-current",
  args: {},
}, { tab: { id: 31 } });
assert.equal(unload.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
assert.equal(executions.some(item => item.name === "navigate"), false);

const screenAction = await bridge.handleToolCall({
  toolName: "act_on_screen",
  sessionId: "s1",
  runId: "run-current",
  args: { tabId: 31, action: "click", returnScreenshot: true, x: 100, y: 100 },
}, { tab: { id: 31 } });
assert.equal(screenAction.ok, true, "fixed-layout screen actions should remain callable from run_script");
const screenActionExecution = executions.find(item => (
  item.name === "act_on_screen" && item.args.returnScreenshot === true
));
assert.ok(screenActionExecution, "run_script must preserve the explicit observation request");
assert.equal(screenActionExecution.context.toolRegistrySnapshot, toolRegistrySnapshot);
assert.equal(screenActionExecution.context.language, "en");
assert.equal(screenActionExecution.context.source, "run_script", "screen actions should receive the existing origin marker used to suppress child animation frames");
assert.equal(screenAction.result.returnScreenshot, true);
assert.equal(screenAction.result._display, undefined, "UI-only animation frames must not cross into page JavaScript");
assert.equal(screenAction.result._image, undefined, "observation bytes must not be exposed to page JavaScript");
assert.deepEqual(screenAction.observation, {
  _image: "data:image/jpeg;base64,YWN0aW9u",
  _imageDetail: "high",
}, "the bridge should carry the observation separately for last-write-wins promotion");
assert.equal(nestedResults.at(-1).args.returnScreenshot, true, "nested result bookkeeping should record the requested arguments");

const screenshot = await bridge.handleToolCall({
  toolName: "screenshot",
  sessionId: "s1",
  runId: "run-current",
  args: { tabId: 31 },
}, { tab: { id: 31 } });
assert.deepEqual(screenshot.observation, {
  _image: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
  _imageDetail: "high",
});
assert.equal(screenshot.result._image, undefined, "promoted screenshot bytes should cross the bridge only once");
assert.equal(screenshot.result.screenshotId, "screen-latest");

const readImage = await bridge.handleToolCall({
  toolName: "read_image",
  sessionId: "s1",
  runId: "run-current",
  args: { tabId: 31, target: "uid:image" },
}, { tab: { id: 31 } });
assert.equal(readImage.observation, undefined, "only screenshot and observed screen actions update the run_script observation slot");
assert.match(readImage.result._image, /^data:image\/png;base64,/, "unrelated nested image tools must keep their existing result contract");

const stale = await bridge.handleToolCall({
  toolName: "read_dom",
  sessionId: "s1",
  runId: "run-stale",
});
assert.equal(stale.code, "RUN_STOPPED");

const returnedError = await bridge.handleToolCall({
  toolName: "returns_error",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(returnedError.ok, false);
assert.equal(returnedError.code, "EXPECTED_FAILURE");

const thrown = await bridge.handleToolCall({
  toolName: "throws",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(thrown.ok, false);
assert.equal(thrown.code, "EXPLODED");

const stored = await bridge.handleToolCall({
  toolName: "store_alias",
  sessionId: "s1",
  runId: "run-current",
  depth: 2,
  args: { action: "upsert", table: "rows", rows: [{ id: 1 }, { id: 2 }] },
}, { tab: { id: 9 } });
assert.equal(stored.ok, true);
assert.equal(stored.artifacts.length, 1);
assert.equal(stored.artifacts[0].table, "rows");
assert.equal(appended.length, 1);
assert.equal(appended[0].artifacts[0].totalRows, 2);
assert.deepEqual(refreshes[0], ["s1", { action: "artifacts", touchSession: true, delay: 400 }]);
assert.equal(executions.at(-1).context.workingTabId, 31);
assert.equal(executions.at(-1).context.senderTabId, 9);
assert.equal(executions.at(-1).context.runScriptToolDepth, 2);
assert.equal(executions.at(-1).context.skillToolRegistrySnapshot, skillToolRegistrySnapshot);
assert.equal(executions.at(-1).context.dynamicContext.pageUrl, "https://example.test/current");
assert.deepEqual(executions.at(-1).context.loadedPluginSkillNames, ["agent-skill", "runtime-skill"]);
assert.equal(nestedResults.at(-1).toolName, "store_alias");
assert.equal(nestedResults.at(-1).runId, "run-current");
assert.equal(readyCount, 11);

assert.deepEqual(
  collector("download_url", { url: "https://example.test/report%20final.csv" }, {}),
  [{
    type: "file",
    sourceTool: "download_url",
    id: "download-url:report final.csv",
    filename: "report final.csv",
    title: "report final.csv",
    url: "https://example.test/report%20final.csv",
    format: "csv",
  }],
);
assert.deepEqual(collector("data_store", { action: "tables" }, { table: "ignored" }), []);
for (const [name, args, result, expected] of [
  ["save_file", {}, { filename: " result.csv ", downloadId: 9, size: 0 }, { id: "download:9", downloadId: 9, size: 0 }],
  ["save_file", { filename: "result.csv" }, {}, { id: "file:result.csv" }],
  ["document_create", {}, { filename: "result.csv", artifactId: "created", downloaded: { downloadId: 9 }, size: 20 },
    { id: "artifact:created", artifactId: "created", downloadId: 9, size: 20 }],
  ["document_create", { filename: "result.csv" }, { downloaded: { downloadId: 9 } },
    { id: "document:result.csv", downloadId: 9 }],
  ["document_download", { filename: "result.csv", artifactId: "saved" }, { downloadId: 9 },
    { id: "artifact:saved", artifactId: "saved", downloadId: 9 }],
  ["document_download", { filename: "result.csv" }, { downloadId: 9 }, { id: "download:9", downloadId: 9 }],
  ["document_download", { filename: "result.csv" }, {}, { id: "document-download:result.csv" }],
]) {
  assert.deepEqual(collector(name, args, result), [{
    type: "file", sourceTool: name, filename: "result.csv", title: "result.csv", format: "csv", ...expected,
  }], `${name} preserves its established ID priority and compact fields`);
}
assert.deepEqual(collector("document_create", {}, { filename: "result.csv", format: "tsv" })[0].format, "tsv");
assert.deepEqual(collector("save_file", {}, { error: "failed", filename: "result.csv" }), []);
assert.deepEqual(collector("document_download", {}, {}), []);

const activatedSkills = [];
const activationBridge = createRunScriptBridge({
  supervisor,
  getRuntime: () => ({ status: "running", loadedPluginSkillNames: activatedSkills }),
  isTerminalRuntimeForRun: () => false,
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  getRunToolContext: async () => ({ loadedPluginSkillNames: activatedSkills }),
  applyNestedToolResult: async ({ toolName, result, isError }) => {
    if (toolName === "load_skill" && !isError) activatedSkills.push(result.name);
  },
  toolRuntime: {
    resolveDefinition: () => null,
    getSchemas: context => [
      ...(context.loadedPluginSkillNames.includes("fresh-skill")
        ? [{ function: { name: "fresh_plugin__run", description: "Fresh", parameters: { type: "object" } } }]
        : []),
    ],
    async execute(name, _args, _signal, context) {
      if (name === "load_skill") return { name: "fresh-skill" };
      if (name === "fresh_plugin__run" && context.loadedPluginSkillNames.includes("fresh-skill")) return { ok: true };
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "UNKNOWN_TOOL" });
    },
  },
  collectArtifacts: () => [],
});
assert.equal((await activationBridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
})).result.tools.length, 0);
assert.equal((await activationBridge.handleToolCall({
  toolName: "load_skill",
  args: { name: "fresh-skill" },
  sessionId: "s1",
  runId: "run-current",
})).ok, true);
assert.equal((await activationBridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
})).result.tools[0].name, "fresh_plugin__run");
assert.equal((await activationBridge.handleToolCall({
  toolName: "fresh_plugin__run",
  sessionId: "s1",
  runId: "run-current",
})).ok, true);

console.log("run_script bridge tests passed");
