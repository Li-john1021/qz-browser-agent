import assert from "node:assert/strict";

const storageData = {};
const listeners = [];

globalThis.chrome = {
  runtime: { id: "test-extension" },
  storage: {
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      },
      removeListener(fn) {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (typeof key === "string") return { [key]: storageData[key] };
        return { ...storageData };
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values || {})) {
          changes[key] = { oldValue: storageData[key], newValue: value };
          storageData[key] = value;
        }
        for (const listener of listeners.slice()) listener(changes, "local");
      },
    },
  },
};

const bridge = await import("../../src/background/mcp/mcp-bridge.js?test=mcp-config");

let config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, false, "MCP bridge should stay disabled by default");

storageData.llmConfig = { debugMode: true };
config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, false, "debug mode cannot enable an unpaired bridge");
assert.equal(config.endpoint, "http://127.0.0.1:18765");
assert.equal(config.token, "");

storageData._qingzhou_mcp_bridge = { enabled: false, endpoint: "http://evil.example:9", token: "secret" };
config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, false, "explicit bridge config should override debug-mode default");
assert.equal(config.endpoint, "http://127.0.0.1:18765", "bridge endpoint should stay localhost-only");
assert.equal(config.token, "secret");

const saved = await bridge.saveQingzhouMcpBridgeConfig({ enabled: true, endpoint: "http://localhost:18765" });
assert.equal(saved.enabled, true);
assert.equal(saved.endpoint, "http://localhost:18765");
assert.equal(storageData._qingzhou_mcp_bridge.enabled, true);

const traces = [];
globalThis.fetch = async () => {
  throw new Error("Failed to fetch");
};
const runtime = bridge.startQingzhouMcpBridge({
  dispatch: async () => ({}),
  describe: () => ({ tools: [] }),
  trace: (message) => traces.push(message),
});
try {
  await waitFor(() => traces.some((message) => message.includes("local bridge unavailable")));
  assert.ok(traces.some((message) => message.includes("enabled; polling")), "bridge should trace debug-mode polling state");
  assert.equal(
    traces.filter((message) => message.includes("local bridge unavailable")).length,
    1,
    "bridge failure trace should be throttled while status is unchanged",
  );
} finally {
  runtime.stop();
}

await chrome.storage.local.set({
  _qingzhou_mcp_bridge: {
    enabled: true,
    token: "test-token",
    endpoint: "http://127.0.0.1:18765",
    clientId: "test-extension",
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    maxBatch: 1,
  },
});

const resultPosts = [];
let pollCount = 0;
let releaseSlowRequest;
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(String(url)).pathname;
  if (pathname === "/v1/qingzhou/poll") {
    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({ requests: [{ id: "slow-1", method: "execute_tool", params: {}, timeoutMs: 1000 }] });
    }
    if (pollCount === 2) {
      return jsonResponse({ requests: [{ id: "fast-1", method: "ping", params: {}, timeoutMs: 1000 }] });
    }
    return jsonResponse({ requests: [] });
  }
  if (pathname === "/v1/qingzhou/result") {
    resultPosts.push(JSON.parse(options.body || "{}"));
    return jsonResponse({ ok: true });
  }
  throw new Error(`unexpected fetch url: ${url}`);
};

const asyncRuntime = bridge.startQingzhouMcpBridge({
  dispatch: async ({ method }) => {
    if (method === "execute_tool") {
      await new Promise(resolve => {
        releaseSlowRequest = resolve;
      });
      return { slow: true };
    }
    if (method === "ping") return { pong: true };
    return {};
  },
  describe: () => ({ methods: ["execute_tool", "ping"] }),
  trace: () => {},
});
try {
  await waitFor(() => resultPosts.some(item => item.requestId === "fast-1"), 1000);
  assert.ok(pollCount >= 2, "bridge should keep polling while a previous request is still running");
  assert.deepEqual(
    resultPosts.find(item => item.requestId === "fast-1")?.result,
    { pong: true },
    "fast request should complete before slow execute_tool resolves",
  );
  assert.equal(
    resultPosts.some(item => item.requestId === "slow-1"),
    false,
    "slow request should not have completed yet",
  );
  releaseSlowRequest();
  await waitFor(() => resultPosts.some(item => item.requestId === "slow-1"), 1000);
} finally {
  asyncRuntime.stop();
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

function jsonResponse(payload) {
  return {
    ok: true,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

// Revoking pairing while a poll is pending must discard the received commands.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true, token: "old-pair", pollIntervalMs: 100 } });
let resolvePoll;
let dispatched = false;
globalThis.fetch = async (_url, options) => {
  assert.equal(options.redirect, "error", "pairing credentials must never follow HTTP redirects");
  return await new Promise(resolve => { resolvePoll = resolve; });
};
const revokedRuntime = bridge.startQingzhouMcpBridge({ dispatch: () => { dispatched = true; }, trace() {} });
try {
  await waitFor(() => resolvePoll);
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true, token: "" } });
  await waitFor(() => !revokedRuntime.config.enabled);
  resolvePoll(jsonResponse({ requests: [{ id: "late", method: "execute_tool" }] }));
  await waitFor(() => !revokedRuntime.inFlight);
  assert.equal(dispatched, false);
} finally { revokedRuntime.stop(); }

// The bridge has already dequeued a command when its pending poll returns.
// Updating model settings must not revoke that command's polling generation.
for (const update of [
  { llmConfig: { model: "different-model", debugMode: false, temperature: 0.4 } },
  { _qingzhou_mcp_bridge: { enabled: true, token: "same-pair", endpoint: "http://127.0.0.1:18765/", pollIntervalMs: 100 } },
]) {
  await chrome.storage.local.set({
    _qingzhou_mcp_bridge: { enabled: true, token: "same-pair", pollIntervalMs: 100 },
    llmConfig: { model: "initial-model", debugMode: true },
  });
  let completePoll;
  let polls = 0;
  const dispatchedIds = [];
  const postedResults = [];
  globalThis.fetch = async (url, options) => {
    if (new URL(String(url)).pathname.endsWith("/result")) {
      postedResults.push(JSON.parse(options.body));
      return jsonResponse({ ok: true });
    }
    polls += 1;
    if (polls === 1) return new Promise(resolve => { completePoll = resolve; });
    return jsonResponse({ requests: [] });
  };
  const unchangedRuntime = bridge.startQingzhouMcpBridge({
    dispatch: ({ id }) => { dispatchedIds.push(id); return { delivered: true }; },
    trace() {},
  });
  try {
    await waitFor(() => completePoll);
    const generation = unchangedRuntime.generation;
    await chrome.storage.local.set(update);
    await new Promise(resolve => setImmediate(resolve));
    completePoll(jsonResponse({ requests: [{ id: "dequeued-before-update", method: "ping" }] }));
    await waitFor(() => postedResults.length === 1, 1000);
    assert.deepEqual(dispatchedIds, ["dequeued-before-update"]);
    assert.equal(postedResults[0].requestId, "dequeued-before-update");
    assert.deepEqual(postedResults[0].result, { delivered: true });
    assert.equal(unchangedRuntime.generation, generation, "equivalent bridge config must preserve polling authority");

    unchangedRuntime.stop();
    await waitFor(() => !unchangedRuntime.inFlight);
    const pollsBeforeRestart = polls;
    unchangedRuntime.start();
    await waitFor(() => polls > pollsBeforeRestart, 1000);
  } finally { unchangedRuntime.stop(); }
}

// Each pairing identity change must still invalidate a pending response, even
// when both old and new tokens are nonempty and the bridge remains enabled.
for (const patch of [
  { endpoint: "http://localhost:18765" },
  { clientId: "replacement-client" },
  { token: "replacement-pair" },
  { enabled: false },
]) {
  const initial = { enabled: true, token: "initial-pair", pollIntervalMs: 100 };
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: initial });
  let completePoll;
  const dispatchedIds = [];
  globalThis.fetch = async () => {
    if (!completePoll) return new Promise(resolve => { completePoll = resolve; });
    return jsonResponse({ requests: [] });
  };
  const changedRuntime = bridge.startQingzhouMcpBridge({
    dispatch: ({ id }) => { dispatchedIds.push(id); },
    trace() {},
  });
  try {
    await waitFor(() => completePoll);
    const generation = changedRuntime.generation;
    await chrome.storage.local.set({ _qingzhou_mcp_bridge: { ...initial, ...patch } });
    await waitFor(() => changedRuntime.generation !== generation);
    completePoll(jsonResponse({ requests: [{ id: "obsolete-pairing", method: "execute_tool" }] }));
    await waitFor(() => !changedRuntime.inFlight);
    assert.deepEqual(dispatchedIds, [], "a changed pairing must not execute the old poll's commands");
  } finally { changedRuntime.stop(); }
}

console.log("qingzhou MCP bridge config tests passed");
