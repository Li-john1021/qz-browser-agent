import assert from "node:assert/strict";
import { callMcpServerTool, inspectMcpServer, listMcpServerTools, resetMcpServerState } from "../../src/background/mcp/mcp-client.js";

const stored = {};
const originalChrome = globalThis.chrome;
globalThis.chrome = { storage: { local: {
  async get(key) { return { [key]: stored[key] }; },
  async set(value) { Object.assign(stored, value); },
} } };
const originalFetch = globalThis.fetch;
const calls = [];
let missingSessions = 0;
let pendingCall;
let markCall;
const tools = [{
  name: "echo", inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}];
const pausedRequests = new Map();
function pauseNext(method) {
  const started = Promise.withResolvers();
  const result = Promise.withResolvers();
  pausedRequests.set(method, { started, result });
  return { started: started.promise, resolve: result.resolve, reject: result.reject };
}
const requestCount = method => calls.filter(value => value === method).length;
globalThis.fetch = async (_url, init = {}) => {
  const request = JSON.parse(String(init.body || "{}"));
  calls.push(request.method);
  const response = result => new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
    status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session" },
  });
  const paused = pausedRequests.get(request.method);
  if (paused) {
    pausedRequests.delete(request.method);
    paused.started.resolve();
    const result = await paused.result.promise;
    return result instanceof Response ? result : response(result);
  }
  if (request.method === "initialize") return response({ protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } });
  if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (request.method === "tools/list") return response({ tools });
  if (request.method === "resources/list") return response({ resources: [{ name: "guide", uri: "test://guide", mimeType: "text/plain" }] });
  if (request.method === "resources/templates/list") return response({ resourceTemplates: [{ name: "page", uriTemplate: "test://page/{id}" }] });
  if (request.method === "prompts/list") return response({ prompts: [{ name: "summarize", arguments: [{ name: "topic", required: true }] }] });
  if (request.method === "tools/call") {
    if (missingSessions > 0) { missingSessions -= 1; return new Response("Session not found", { status: 404 }); }
    if (pendingCall) { markCall(); return pendingCall; }
    return response({ content: [{ type: "text", text: String(request.params.arguments.value) }], structuredContent: request.params.arguments });
  }
  return new Response(null, { status: 405 });
};
const server = { id: "unit", url: "https://mcp.example.test/mcp" };
try {
  const [first, second] = await Promise.all([
    listMcpServerTools(server, { refresh: true }), listMcpServerTools(server, { refresh: true }),
  ]);
  assert.equal(first[0].name, "echo"); assert.deepEqual(second, first);
  assert.equal(calls.filter(method => method === "initialize").length, 1, "concurrent callers share connection initialization");
  const inspected = await inspectMcpServer(server, { includeResources: true, includePrompts: true, signal: null });
  assert.deepEqual(inspected.errors, []);
  assert.equal(inspected.resources.resources[0].uri, "test://guide");
  assert.equal(inspected.resources.resourceTemplates[0].uriTemplate, "test://page/{id}");
  assert.deepEqual(inspected.prompts.prompts[0].arguments, [{ name: "topic", required: true }]);
  assert.equal(calls.filter(method => method === "initialize").length, 1, "metadata operations reuse the same SDK connection");
  resetMcpServerState(server);
  const requestsBeforeCache = calls.length;
  assert.deepEqual(await listMcpServerTools(server), first);
  assert.equal(calls.length, requestsBeforeCache, "persisted metadata avoids reconnect after reset");

  await assert.rejects(callMcpServerTool(server, "echo", { value: 42 }), error => error.code === "MCP_-32602",
    "a persisted catalog must not bypass validation on the new connection");
  assert.equal((await callMcpServerTool(server, "echo", { value: "cached recovery" })).text, "cached recovery");

  const callsBeforeRetry = requestCount("tools/call");
  const listsBeforeRetry = requestCount("tools/list");
  missingSessions = 1;
  const retried = await callMcpServerTool(server, "echo", { value: "recovered" });
  assert.equal(retried.text, "recovered");
  assert.equal(requestCount("tools/call") - callsBeforeRetry, 2, "missing remote session retries once");
  assert.equal(requestCount("tools/list") - listsBeforeRetry, 1, "the replacement connection initializes its own metadata");
  missingSessions = 1;
  await assert.rejects(callMcpServerTool(server, "echo", { value: 42 }), error => error.code === "MCP_-32602",
    "invalid output must still be rejected after a 404 reconnect");
  missingSessions = 2;
  await assert.rejects(callMcpServerTool(server, "echo", {}), error => /404/.test(String(error.code || error.message)));
  assert.equal(missingSessions, 0, "a second missing session terminates without an unbounded retry loop");

  const controller = new AbortController();
  const started = new Promise(resolve => { markCall = resolve; });
  pendingCall = new Promise(() => {});
  const cancelled = callMcpServerTool(server, "echo", {}, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, error => error.name === "AbortError" || /abort/i.test(String(error.message || error)));
  await started;
  controller.abort();
  await rejected;
  pendingCall = null;
  assert.equal((await callMcpServerTool(server, "echo", { value: "after cancellation" })).text, "after cancellation");

  resetMcpServerState(server);
  const initialList = pauseNext("tools/list");
  const callsBeforeSharedList = requestCount("tools/call");
  const listsBeforeSharedList = requestCount("tools/list");
  const firstCall = callMcpServerTool(server, "echo", { value: "first" });
  await initialList.started;
  const concurrentCall = callMcpServerTool(server, "echo", { value: "second" });
  const concurrentRefresh = listMcpServerTools(server, { refresh: true });
  assert.equal(requestCount("tools/call"), callsBeforeSharedList, "calls wait until SDK metadata is ready");
  initialList.resolve({ tools });
  const shared = await Promise.all([firstCall, concurrentCall, concurrentRefresh]);
  assert.equal(shared[0].text, "first");
  assert.equal(shared[1].text, "second");
  assert.deepEqual(shared[2], first);
  assert.equal(requestCount("tools/list") - listsBeforeSharedList, 1, "concurrent call and explicit refresh share initialization");

  const refreshGate = pauseNext("tools/list");
  const refresh = listMcpServerTools(server, { refresh: true });
  await refreshGate.started;
  const waitingCall = callMcpServerTool(server, "echo", { value: 42 });
  const rejectedWaitingCall = assert.rejects(waitingCall, error => error.code === "MCP_-32602");
  const beforeRefreshReady = requestCount("tools/call");
  refreshGate.resolve({ tools });
  await refresh;
  await rejectedWaitingCall;
  assert.equal(requestCount("tools/call") - beforeRefreshReady, 1, "calls during refresh wait and validate against the completed metadata");

  const inFlightGate = pauseNext("tools/call");
  const inFlight = callMcpServerTool(server, "echo", { value: "in flight" });
  const rejectedInFlight = assert.rejects(inFlight, /closed|连接已关闭/i);
  await inFlightGate.started;
  const brokenRefresh = pauseNext("tools/list");
  const failedRefresh = listMcpServerTools(server, { refresh: true });
  const rejectedRefresh = assert.rejects(failedRefresh, /Duplicate schema URI/);
  await brokenRefresh.started;
  brokenRefresh.resolve({ tools: [{ name: "broken", inputSchema: { type: "object" }, outputSchema: {
    type: "object", properties: {
      a: { $id: "https://schema.example.test/duplicate" }, b: { $id: "https://schema.example.test/duplicate" },
    },
  } }, ...tools] });
  await rejectedRefresh;
  await rejectedInFlight;
  inFlightGate.resolve({ content: [], structuredContent: { value: "late" } });
  const beforeCachedFailure = calls.length;
  assert.deepEqual(await listMcpServerTools(server), first, "failed schema refresh retains the last usable display catalog");
  assert.equal(calls.length, beforeCachedFailure);
  const connectionsBeforeRecovery = requestCount("initialize");
  assert.equal((await callMcpServerTool(server, "echo", { value: "refresh recovery" })).text, "refresh recovery");
  await assert.rejects(callMcpServerTool(server, "echo", { value: 42 }), error => error.code === "MCP_-32602");
  assert.equal(requestCount("initialize") - connectionsBeforeRecovery, 1, "failed refresh replaces the potentially incomplete SDK validator cache");

  resetMcpServerState(server);
  const failedList = pauseNext("tools/list");
  const failedInitialization = callMcpServerTool(server, "echo", { value: "unavailable" });
  const rejectedInitialization = assert.rejects(failedInitialization, error => error.code === "MCP_503");
  await failedList.started;
  failedList.resolve(new Response("Unavailable", { status: 503 }));
  await rejectedInitialization;
  assert.equal((await callMcpServerTool(server, "echo", { value: "retry initialization" })).text, "retry initialization");

  for (const phase of ["initialize", "tools/list"]) {
    resetMcpServerState(server);
    const oldGate = pauseNext(phase);
    const oldCall = callMcpServerTool(server, "echo", { value: "old" });
    const rejectedOldCall = assert.rejects(oldCall, /closed|连接已关闭/i);
    await oldGate.started;
    resetMcpServerState(server);
    const replacement = callMcpServerTool(server, "echo", { value: "replacement" });
    oldGate.reject(new Error("late old connection failure"));
    await rejectedOldCall;
    assert.equal((await replacement).text, "replacement");
    const connectionsAfterReplacement = requestCount("initialize");
    await assert.rejects(callMcpServerTool(server, "echo", { value: 42 }), error => error.code === "MCP_-32602");
    assert.equal(requestCount("initialize"), connectionsAfterReplacement, `${phase}: stale cleanup must not delete the replacement connection`);
    assert.deepEqual(await listMcpServerTools(server), first, `${phase}: old work cannot replace the new catalog`);
  }

  const NativeFunction = globalThis.Function;
  globalThis.Function = function () { throw new EvalError("MV3 CSP forbids generated code"); };
  try {
    await listMcpServerTools(server, { refresh: true });
    assert.deepEqual((await callMcpServerTool(server, "echo", { value: "valid" })).structuredContent, { value: "valid" });
    for (const args of [{ value: 42 }, {}]) {
      await assert.rejects(callMcpServerTool(server, "echo", args), error => error.code === "MCP_-32602");
    }
    assert.equal((await callMcpServerTool(server, "echo", { value: "recovered" })).text, "recovered");
  } finally {
    globalThis.Function = NativeFunction;
  }
} finally {
  resetMcpServerState(server);
  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
}
console.log("MCP connection metadata, persisted cache, shared refresh, failure recovery, stale cleanup and CSP-safe validation passed");
