import assert from "node:assert/strict";
import { createMcpRuntime } from "../../src/background/mcp/mcp-runtime.js";

const broadcasts = [];
const executed = [];
const toolReadinessReasons = [];
const loadedNames = [];
const loadedDocumentResources = [];
const promptTasks = [];
let activeRunId = "run-1";
const waits = new Map([["wait-1", true], ["wait-2", true]]);
const runtimeState = {
  sessionId: "s1",
  status: "completed",
  runId: "run-1",
  workingTabId: 8,
  workingUrl: "https://example.test/page",
  workingTab: { id: 8, url: "https://example.test/page" },
  visitedTaskSites: [{ id: 7, url: "https://docs.test/" }],
};
const transcript = [{ type: "assistant", content: "done" }];
const conversation = [{ role: "system", content: "system" }, { role: "assistant", content: "done" }];
const skillItems = [{
  name: "research",
  metadata: { displayName: "Research" },
  description: "Web research workflow",
  scope: "global",
  content: "Use tools carefully.",
  resources: [
    { path: "references/guide.md", type: "reference", title: "Guide", content: "abcdefghij" },
    { path: "references/template.xlsx", type: "asset", encoding: "base64", size: 4, content: "UEsDBA==" },
  ],
}];

const sessions = {
  normalizeId: value => String(value || "").trim(),
  requireId(value, operation) {
    const id = String(value || "").trim();
    if (!id) throw new Error(`${operation} requires sessionId`);
    return id;
  },
  supervisor: {
    isRunCurrent(sessionId, runId) {
      return sessionId === "s1" && runId === activeRunId;
    },
    resolveUserWait({ waitId }) {
      if (!waits.has(waitId)) return false;
      waits.delete(waitId);
      return true;
    },
    rejectUserWait({ waitId }) {
      if (!waits.has(waitId)) return false;
      waits.delete(waitId);
      return true;
    },
  },
  async startPromptTask(input) {
    promptTasks.push(input);
    return { promise: Promise.resolve(), runId: "run-2" };
  },
  waitForRunObserved: async () => true,
  getRuntimeOutput: async () => ({ ...runtimeState }),
  getLiveAgentEntry: async () => null,
  setRuntime() {},
  getLastMessages: async ({ sessionId, num }) => ({ sessionId, num, messages: transcript.slice(-num) }),
  getAgent: async () => ({ exportSession: () => conversation }),
  getTranscript: async () => transcript,
  listMetadata: async () => ({ s1: { id: "s1", title: "Session" } }),
  getConversation: async () => conversation,
  compactTranscriptEvent: event => ({ ...event, compact: true }),
  getRuntime: () => ({ ...runtimeState }),
};

const toolRuntime = {
  getSchemas: () => [{
    type: "function",
    function: { name: "read_dom", description: "Read", parameters: { type: "object" } },
  }],
  async execute(name, args, signal, context) {
    executed.push({ name, args, signal, context });
    if (name === "load_skill") return { name: "research", displayName: "Research" };
    return { ok: true };
  },
};
const tools = {
  ready: async reason => { toolReadinessReasons.push(reason); },
  canManageSessions: async () => true,
  buildRunProfile: async ({ sessionId }) => ({ sessionId }),
  runtime: toolRuntime,
  loadedSkillNames: (_sessionId, extra) => ["existing", ...extra],
  recordLoadedSkillNames: (...args) => loadedNames.push(args),
};
const skills = {
  list: async () => skillItems,
  load: async name => skillItems.find(skill => skill.name === name) || null,
  getDisplayName: skill => skill.metadata?.displayName || skill.name,
  normalizeResourcePath: value => String(value || "").replace(/^\/+/, ""),
  async loadDocumentResource(input, runtime) {
    loadedDocumentResources.push({ input, runtime });
    return {
      name: input.skill.name,
      path: input.path,
      format: "xlsx",
      document: { docModelId: "model_skill_test" },
      rows: [{ value: 1 }],
    };
  },
};
const runtime = createMcpRuntime({
  sessions,
  tools,
  skills,
  artifacts: {
    empty: () => ({ total: 0, items: [], dataTables: [], imageCollections: [], files: [] }),
    collect: async () => ({ total: 1, items: [{ type: "file" }] }),
  },
  trace: { get: async () => ["s1 trace", "other trace"] },
  async dispatchSidepanel(message, port) {
    port.postMessage({ type: "first", requestId: message.requestId });
    port.postMessage({ type: "second", requestId: message.requestId });
  },
  broadcast: event => broadcasts.push(event),
  storageKey: () => "_mcp_config",
});

assert.equal(runtime.describe().storageKey, "_mcp_config");
assert.ok(runtime.describe().methods.includes("execute_tool"));

const dispatched = await runtime.dispatchRuntimeMessage({ type: "test", requestId: "req-1" }, { expectedType: "first" });
assert.equal(dispatched.response.type, "first");
assert.equal(dispatched.responses.length, 2);

assert.deepEqual(runtime.continueUserWait({ sessionId: "s1", waitId: "wait-1" }), {
  accepted: true,
  sessionId: "s1",
  waitId: "wait-1",
  submitted: false,
  reason: "continued",
});
assert.equal(runtime.cancelUserWait({ sessionId: "s1", waitId: "missing" }).stale, true);
assert.equal(broadcasts.at(-1).type, "user_wait_resolved");
assert.equal(runtime.submitWaitForm({ sessionId: "s1", waitId: "wait-2", answers: { choice: "a" } }).submitted, true);

await assert.rejects(() => runtime.sendMessage({ text: "missing id" }), /requires sessionId/);
await assert.rejects(() => runtime.sendMessage({ sessionId: "s1", text: "  " }), /requires text/);
const onMessageAccepted = () => {};
const sent = await runtime.sendMessage({
  sessionId: "s1", text: "go", wait: true, onMessageAccepted,
});
assert.equal(sent.accepted, true);
assert.equal(sent.wait, true);
assert.equal(promptTasks.length, 1);
assert.equal(promptTasks[0].onMessageAccepted, onMessageAccepted);
assert.equal(promptTasks[0].swallowErrors, true);
await runtime.sendMessage({ sessionId: "s1", text: "surface acceptance errors", swallowErrors: false });
assert.equal(promptTasks.at(-1).swallowErrors, false);

const state = await runtime.getState("s1");
assert.equal(state.status, "completed");
assert.equal(state.isStreaming, false);
assert.deepEqual(await runtime.getMessages("s1"), { sessionId: "s1", session: conversation, transcript });
assert.equal((await runtime.getMessages("s1", { tail: true, num: 1 })).num, 1);

const listedTools = await runtime.listTools({ sessionId: "s1", loadedPluginSkillNames: ["extra"] });
assert.deepEqual(listedTools.tools.map(tool => tool.name), ["read_dom"]);
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools"]);
const inputContext = { marker: true };
const activeRunTool = await runtime.executeTool({ sessionId: "s1", name: "read_dom", args: { selector: "main" }, dynamicContext: inputContext });
assert.deepEqual(inputContext, { marker: true }, "MCP execution must not mutate caller-owned context");
assert.equal(executed.at(-1).context.source, "mcp_bridge");
assert.equal(executed.at(-1).context.dynamicContext.pageUrl, runtimeState.workingUrl);
assert.equal(executed.at(-1).context.runId, "run-1", "MCP should inherit only the Session's live run");
assert.equal(activeRunTool.runId, "run-1");
const explicitRunTool = await runtime.executeTool({ sessionId: "s1", runId: "public-run", name: "read_dom", args: {} });
assert.equal(executed.at(-1).context.runId, "public-run", "the public MCP runId must reach tool execution unchanged");
assert.equal(explicitRunTool.runId, "public-run");
activeRunId = "";
await runtime.executeTool({ sessionId: "s1", name: "load_skill", args: { name: "research" } });
assert.equal(executed.at(-1).context.runId, "", "a completed runtime id must not be reused as a live run");
assert.deepEqual(loadedNames.at(-1), ["s1", ["research", "Research"]]);
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools", "mcp_execute_tool", "mcp_execute_tool", "mcp_execute_tool"]);

const listedSkills = await runtime.listSkills({ scope: "global", query: "guide" });
assert.equal(listedSkills.count, 1);
assert.equal(listedSkills.items[0].content, undefined);
const loadedSkill = await runtime.getSkill({ sessionId: "s1", name: "research" });
assert.equal(loadedSkill.content, "Use tools carefully.");
assert.match(loadedSkill.runtime, /Chrome 浏览器扩展/);
const chunk = await runtime.getSkillResource({ name: "research", path: "/references/guide.md", start: 2, maxChars: 4 });
assert.deepEqual({ content: chunk.content, start: chunk.start, end: chunk.end, truncated: chunk.truncated }, {
  content: "cdef",
  start: 2,
  end: 6,
  truncated: true,
});
const documentResource = await runtime.getSkillResource({ sessionId: "s1", runId: "run-1", name: "research", path: "references/template.xlsx" });
assert.equal(documentResource.document.docModelId, "model_skill_test");
assert.equal(loadedDocumentResources[0].input.resource.encoding, "base64");
assert.equal(loadedDocumentResources[0].runtime.context.sessionId, "s1");
assert.equal(loadedDocumentResources[0].runtime.context.source, "mcp_bridge");
assert.equal((await runtime.getSkill({ name: "missing" })).code, "SKILL_NOT_FOUND");
assert.equal((await runtime.getSkillResource({ name: "research", path: "missing.md" })).code, "SKILL_RESOURCE_NOT_FOUND");

const snapshot = await runtime.getSnapshot("s1", {
  includeArtifacts: false,
  includeTools: true,
  includeTrace: true,
  traceLimit: 5,
});
assert.equal(snapshot.artifacts.total, 0);
assert.equal(snapshot.toolCount, 1);
assert.deepEqual(snapshot.trace, ["s1 trace"]);
assert.equal(snapshot.tail[0].compact, true);

console.log("MCP runtime tests passed");
