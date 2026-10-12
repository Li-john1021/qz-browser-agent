import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityChat } from "../../src/background/llm/capability-chat.js";
import { createLlmGateway } from "../../src/background/llm/index.js";
import { createLlmRetryPolicy } from "../../src/background/llm/transport.js";

test("capability chat forwards identity, messages and results without leaking internal options", async () => {
  const messages = [{ role: "user", content: "Summarize this page." }];
  const tools = [{ name: "lookup" }];
  const signal = new AbortController().signal;
  const result = { message: { role: "assistant", content: "Summary" }, usage: { total_tokens: 3 } };
  const pending = Promise.resolve(result);
  let captured;
  const chat = createCapabilityChat((...args) => { captured = args; return pending; });
  const options = { sessionId: "session", runId: "run", config: { provider: "other" }, providerDefinition: {},
    headers: { Authorization: "unused" }, baseHeaders: {}, rawExchange: {}, retry: { maxRetries: 100 },
    rateLimit: false, onProviderResponse() { throw new Error("must not execute"); } };
  const response = chat(messages, tools, signal, options);
  assert.equal(response, pending);
  assert.equal(await response, result);
  assert.equal(captured[0], messages);
  assert.equal(captured[1], tools);
  assert.equal(captured[2], signal);
  assert.deepEqual(captured[3], { sessionId: "session", runId: "run" });
  assert.notEqual(captured[3], options);
  assert.equal(options.config.provider, "other", "the caller's options are not mutated");
});

test("capability chat supports calls without identity and preserves gateway failures", async () => {
  const failure = new Error("provider failed");
  let captured;
  const chat = createCapabilityChat((...args) => { captured = args; return Promise.reject(failure); });
  await assert.rejects(chat([], []), error => error === failure);
  assert.equal(captured[2], undefined);
  assert.deepEqual(captured[3], { sessionId: undefined, runId: undefined });
});

test("capability chat preserves cancellation of an in-flight gateway request", async () => {
  const controller = new AbortController();
  const chat = createCapabilityChat((_messages, _tools, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = chat([], [], controller.signal, { sessionId: "session", runId: "run" });
  const failure = new DOMException("cancelled", "AbortError");
  controller.abort(failure);
  await assert.rejects(pending, error => error === failure);
});

test("capability requests keep the gateway's configured provider and retry defaults", async () => {
  const config = { provider: "custom", customProtocol: "fixture", customEndpoint: "https://fixture.invalid",
    apiKey: "fixture", model: "configured-model" };
  const signal = new AbortController().signal;
  let received;
  const gateway = createLlmGateway({ rateGovernor: null, rateLearning: null,
    resolveConfig: async options => options.config || config,
    adapters: { fixture: {
      async chat(messages, tools, signal, options, config) {
        received = { messages, tools, signal, options, config };
        return { message: { role: "assistant", content: config.model } };
      },
      async *chatStream() { throw new Error("not a streaming request"); },
    } },
  });
  const chat = createCapabilityChat(gateway.chat);
  const response = await chat([{ role: "user", content: "hello" }], [], signal, {
    sessionId: "session", runId: "run", config: { ...config, model: "unexpected" },
    retry: { maxRetries: 100 }, headers: { Authorization: "unexpected" }, rawExchange: {},
  });
  assert.equal(response.message.content, "configured-model");
  assert.equal(received.config, config);
  assert.equal(received.signal, signal);
  assert.equal(received.options.sessionId, "session");
  assert.equal(received.options.runId, "run");
  assert.equal(received.options.providerDefinition.protocol, "fixture");
  const { delayMs: _receivedDelay, ...receivedPolicy } = createLlmRetryPolicy(received.options);
  const { delayMs: _defaultDelay, ...defaultPolicy } = createLlmRetryPolicy();
  assert.deepEqual(receivedPolicy, defaultPolicy);
  assert.equal(received.options.headers, undefined);
  assert.equal(received.options.rawExchange, undefined);
});
