import assert from "node:assert/strict";
import {
  createSkillNetworkService,
} from "../../src/background/skills/skill-network.js";

const dnrCalls = [];
const fetchCalls = [];
const runtime = {
  id: "qingzhou-test-extension",
  getURL(path) {
    return `chrome-extension://${this.id}/${path}`;
  },
};
const sender = {
  id: runtime.id,
  url: runtime.getURL("offscreen.html"),
};
const service = createSkillNetworkService({
  runtime,
  declarativeNetRequest: {
    async updateSessionRules(payload) {
      dnrCalls.push(structuredClone(payload));
    },
  },
  getSecurityGuardrails: async () => ({ rules: [] }),
  fetch: async (url, init) => {
    fetchCalls.push({
      url: String(url),
      method: init.method,
      headers: Array.from(init.headers.entries()),
      body: init.body ? new TextDecoder().decode(init.body) : "",
      credentials: init.credentials,
      redirect: init.redirect,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-result": "yes" },
    });
  },
});

const plugin = {
  id: "network-example",
  skillName: "network-skill",
  network: {
    allowedOrigins: [{ setting: "endpoint" }],
    allowedMethods: ["GET", "POST"],
    browserManagedHeaders: ["date"],
    maxRequestBytes: 1024,
    maxResponseBytes: 4096,
  },
};
const unregister = service.registerExecution("run-1", {
  plugin,
  config: { endpoint: "https://api.example.test/v1" },
});
const wireDate = "Fri, 17 Jul 2026 02:00:00 GMT";
const response = await service.execute({
  requestId: "run-1",
  request: {
    url: "https://api.example.test/v1/query?x=1",
    method: "POST",
    headers: [
      ["content-type", "application/json"],
      ["authorization", "Example signed-value"],
      ["date", wireDate],
    ],
    bodyBase64: Buffer.from('{"q":1}').toString("base64"),
  },
}, sender);

assert.equal(response.status, 200);
assert.equal(Buffer.from(response.bodyBase64, "base64").toString("utf8"), '{"ok":true}');
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].method, "POST");
assert.equal(fetchCalls[0].body, '{"q":1}');
assert.equal(fetchCalls[0].credentials, "omit");
assert.equal(fetchCalls[0].redirect, "error");
assert.equal(fetchCalls[0].headers.some(([name]) => name === "date"), false, "browser-managed headers must not be passed to Fetch");
assert.equal(fetchCalls[0].headers.some(([name, value]) => name === "authorization" && value === "Example signed-value"), true);
assert.equal(dnrCalls.length, 2, "managed header rule must be installed and removed around one request");
assert.equal(dnrCalls[0].addRules[0].action.requestHeaders[0].header, "Date");
assert.equal(dnrCalls[0].addRules[0].action.requestHeaders[0].value, wireDate);
assert.deepEqual(dnrCalls[0].addRules[0].condition.requestMethods, ["post"]);
assert.deepEqual(dnrCalls[0].addRules[0].condition.initiatorDomains, [runtime.id]);
assert.match("https://api.example.test/v1/query?x=1", new RegExp(dnrCalls[0].addRules[0].condition.regexFilter));
assert.deepEqual(dnrCalls[1], { removeRuleIds: [dnrCalls[0].addRules[0].id] });

await assertRejectsCode(service.execute({
  requestId: "run-1",
  request: { url: "https://other.example.test/data", method: "GET", headers: [] },
}, sender), "SKILL_NETWORK_ORIGIN_NOT_ALLOWED");
await assertRejectsCode(service.execute({
  requestId: "run-1",
  request: { url: "https://api.example.test/data", method: "DELETE", headers: [] },
}, sender), "SKILL_NETWORK_METHOD_NOT_ALLOWED");
await assertRejectsCode(service.execute({
  requestId: "run-1",
  request: { url: "https://api.example.test/data", method: "GET", headers: [["cookie", "secret"]] },
}, sender), "SKILL_NETWORK_HEADER_FORBIDDEN");
await assertRejectsCode(service.execute({
  requestId: "run-1",
  request: { url: "https://api.example.test/data", method: "GET", headers: [["date", wireDate]] },
}, { ...sender, id: "foreign-extension" }), "SKILL_NETWORK_CALLER_UNTRUSTED");

unregister();
await assertRejectsCode(service.execute({
  requestId: "run-1",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender), "SKILL_NETWORK_EXECUTION_EXPIRED");

const guardedService = createSkillNetworkService({
  runtime,
  fetch: async () => new Response("not reached"),
  getSecurityGuardrails: async () => ({
    rules: [{ action: "block", type: "domain", value: "api.example.test" }],
  }),
});
guardedService.registerExecution("guarded", { plugin, config: { endpoint: "https://api.example.test" } });
await assertRejectsCode(guardedService.execute({
  requestId: "guarded",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender), "SECURITY_GUARDRAIL_BLOCKED");

const cleanupCalls = [];
const failingService = createSkillNetworkService({
  runtime,
  declarativeNetRequest: {
    async updateSessionRules(payload) {
      cleanupCalls.push(structuredClone(payload));
    },
  },
  fetch: async () => {
    throw new Error("network down");
  },
  getSecurityGuardrails: async () => ({ rules: [] }),
});
failingService.registerExecution("failing", { plugin, config: { endpoint: "https://api.example.test" } });
await assert.rejects(failingService.execute({
  requestId: "failing",
  request: {
    url: "https://api.example.test/data",
    method: "GET",
    headers: [["date", wireDate]],
  },
}, sender), /network down/);
assert.equal(cleanupCalls.length, 2);
assert.deepEqual(cleanupCalls[1], { removeRuleIds: [cleanupCalls[0].addRules[0].id] });

const smallResponseService = createSkillNetworkService({
  runtime,
  fetch: async () => new Response("x".repeat(32), { headers: { "content-length": "32" } }),
  getSecurityGuardrails: async () => ({ rules: [] }),
});
smallResponseService.registerExecution("small", {
  plugin: { ...plugin, network: { ...plugin.network, maxResponseBytes: 16 } },
  config: { endpoint: "https://api.example.test" },
});
await assertRejectsCode(smallResponseService.execute({
  requestId: "small",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender), "SKILL_NETWORK_RESPONSE_TOO_LARGE");

let streamCancelled = false;
const streamingResponseService = createSkillNetworkService({
  runtime,
  fetch: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(12));
      controller.enqueue(new Uint8Array(12));
    },
    cancel() {
      streamCancelled = true;
    },
  })),
  getSecurityGuardrails: async () => ({ rules: [] }),
});
streamingResponseService.registerExecution("streaming", {
  plugin: { ...plugin, network: { ...plugin.network, maxResponseBytes: 16 } },
  config: { endpoint: "https://api.example.test" },
});
await assertRejectsCode(streamingResponseService.execute({
  requestId: "streaming",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender), "SKILL_NETWORK_RESPONSE_TOO_LARGE");
assert.equal(streamCancelled, true, "an oversized streaming response should be cancelled before full buffering");

const staleRuleCalls = [];
const staleRuleService = createSkillNetworkService({
  runtime,
  declarativeNetRequest: {
    async getSessionRules() {
      return [{ id: 1_930_000_123 }, { id: 77 }];
    },
    async updateSessionRules(payload) {
      staleRuleCalls.push(structuredClone(payload));
    },
  },
  fetch: async () => new Response("ok"),
  getSecurityGuardrails: async () => ({ rules: [] }),
});
staleRuleService.registerExecution("stale", { plugin, config: { endpoint: "https://api.example.test" } });
await staleRuleService.execute({
  requestId: "stale",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender);
assert.deepEqual(staleRuleCalls, [{ removeRuleIds: [1_930_000_123] }], "startup cleanup must stay inside the Skill network rule range");

let failedCleanupAttempts = 0;
let ordinaryFetches = 0;
const cleanupFailureService = createSkillNetworkService({
  runtime,
  declarativeNetRequest: {
    async getSessionRules() {
      failedCleanupAttempts += 1;
      throw new Error("temporary DNR failure");
    },
    async updateSessionRules() {},
  },
  fetch: async () => {
    ordinaryFetches += 1;
    return new Response("ok");
  },
  getSecurityGuardrails: async () => ({ rules: [] }),
});
cleanupFailureService.registerExecution("cleanup-failure", { plugin, config: { endpoint: "https://api.example.test" } });
await cleanupFailureService.execute({
  requestId: "cleanup-failure",
  callId: "ordinary-call",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender);
assert.equal(ordinaryFetches, 1, "DNR cleanup failure must not disable requests that use no browser-managed headers");
assert.equal(failedCleanupAttempts, 1, "ordinary fetch should not retry an unrelated DNR cleanup failure");

let retryCleanupAttempts = 0;
const retryRuleCalls = [];
const retryCleanupService = createSkillNetworkService({
  runtime,
  declarativeNetRequest: {
    async getSessionRules() {
      retryCleanupAttempts += 1;
      if (retryCleanupAttempts === 1) throw new Error("transient DNR failure");
      return [];
    },
    async updateSessionRules(payload) {
      retryRuleCalls.push(structuredClone(payload));
    },
  },
  fetch: async () => new Response("ok"),
  getSecurityGuardrails: async () => ({ rules: [] }),
});
retryCleanupService.registerExecution("cleanup-retry", { plugin, config: { endpoint: "https://api.example.test" } });
await retryCleanupService.execute({
  requestId: "cleanup-retry",
  callId: "managed-call",
  request: { url: "https://api.example.test/data", method: "GET", headers: [["date", wireDate]] },
}, sender);
assert.equal(retryCleanupAttempts, 2, "a managed-header request should retry transient stale-rule cleanup");
assert.equal(retryRuleCalls.length, 2, "the retried managed-header request should still install and remove exactly one temporary rule");

let resolveFetchStarted;
const fetchStarted = new Promise(resolve => { resolveFetchStarted = resolve; });
const cancellableService = createSkillNetworkService({
  runtime,
  fetch: async (_url, init) => {
    resolveFetchStarted();
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  },
  getSecurityGuardrails: async () => ({ rules: [] }),
});
cancellableService.registerExecution("cancellable", { plugin, config: { endpoint: "https://api.example.test" } });
const pendingFetch = cancellableService.execute({
  requestId: "cancellable",
  callId: "fetch-1",
  request: { url: "https://api.example.test/data", method: "GET", headers: [] },
}, sender);
await fetchStarted;
assert.deepEqual(
  cancellableService.cancel({ requestId: "cancellable", callId: "fetch-1" }, sender),
  { cancelled: true, requestId: "cancellable", callId: "fetch-1" },
);
await assertRejectsCode(pendingFetch, "OPERATION_ABORTED");
assert.deepEqual(
  cancellableService.cancel({ requestId: "cancellable", callId: "fetch-1" }, sender),
  { cancelled: false, requestId: "cancellable", callId: "fetch-1" },
  "cancelling a settled fetch should be an idempotent no-op",
);

const binaryPayload = Uint8Array.from({ length: 70000 }, (_, index) => index % 256);
const binaryWire = Buffer.from(binaryPayload).toString("base64");
const binaryService = createSkillNetworkService({
  runtime,
  getSecurityGuardrails: async () => ({ rules: [] }),
  fetch: async (_url, init) => {
    assert.deepEqual(init.body, binaryPayload, "the request decodes every byte without text conversion");
    return new Response(binaryPayload, { headers: { "content-type": "application/octet-stream" } });
  },
});
binaryService.registerExecution("binary", {
  plugin: { ...plugin, network: { ...plugin.network, maxRequestBytes: 100000, maxResponseBytes: 100000 } },
  config: { endpoint: "https://api.example.test" },
});
const binaryResponse = await binaryService.execute({
  requestId: "binary", callId: "roundtrip",
  request: { url: "https://api.example.test/data", method: "POST", headers: [], bodyBase64: binaryWire },
}, sender);
assert.equal(binaryResponse.bodyBase64, binaryWire, "response encoding preserves bytes across multiple conversion chunks");

console.log("skill network tests passed");

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error?.code, code);
    return true;
  });
}
