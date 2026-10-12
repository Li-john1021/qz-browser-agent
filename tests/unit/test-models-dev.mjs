import assert from "node:assert/strict";
import test from "node:test";
import { providers as snapshot } from "@opencode-ai/models/snapshot";

import { createModelsDevDirectory, getModelsDevProviderIndex } from "../../src/shared/models/models-dev.js";
import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
await loadModelsDevFixture();
const loadDirectory = async () => {
  const directory = createModelsDevDirectory(async () => snapshot);
  await directory.loadBundledModelsDevProviders();
  return directory;
};
const model = (id, metadata = {}) => ({ id, name: id, ...metadata });
const provider = (id, models, fields = {}) => ({
  id, name: `Test ${id}`, npm: "@ai-sdk/openai-compatible", env: ["TEST_API_KEY"],
  api: "https://example.test/v1", models, ...fields,
});
const json = value => new Response(JSON.stringify(value), { status: 200 });

test("provider routing is ready before model data is requested", async context => {
  let reads = 0;
  const directory = createModelsDevDirectory(async () => { reads++; return snapshot; });
  assert.ok(Object.keys(getModelsDevProviderIndex()).length > 100);
  assert.deepEqual(directory.getModelsDevProviders(), {});
  assert.equal(reads, 0);
  assert.equal(await directory.loadBundledModelsDevProviders(), snapshot);
  assert.equal(await directory.loadBundledModelsDevProviders(), snapshot);
  assert.equal(reads, 1);
});

test("concurrent local loads share work while cancellation remains per caller", async () => {
  let finish;
  let reads = 0;
  const directory = createModelsDevDirectory(() => { reads++; return new Promise(resolve => { finish = resolve; }); });
  const controller = new AbortController();
  const cancelled = directory.loadBundledModelsDevProviders(controller.signal);
  const surviving = directory.loadBundledModelsDevProviders();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(directory.getModelsDevProviders(), {});
  finish(snapshot);
  assert.equal(await surviving, snapshot);
  assert.equal(await directory.loadBundledModelsDevProviders(), snapshot);
  await assert.rejects(directory.loadBundledModelsDevProviders(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(reads, 1);
});

test("failed and malformed local loads can be retried without publishing partial data", async () => {
  let reads = 0;
  const directory = createModelsDevDirectory(async () => {
    if (++reads === 1) throw new Error("Asset unavailable");
    return reads === 2 ? { invalid: {} } : snapshot;
  });
  await assert.rejects(directory.loadBundledModelsDevProviders(), /Asset unavailable/);
  await assert.rejects(directory.loadBundledModelsDevProviders(), /Invalid bundled model directory/);
  assert.deepEqual(directory.getModelsDevProviders(), {});
  assert.equal(await directory.loadBundledModelsDevProviders(), snapshot);
  assert.equal(reads, 3);
});

for (const [name, response] of [
  ["network failure", () => { throw new TypeError("Offline"); }],
  ["HTTP 500", () => new Response("Unavailable", { status: 500 })],
  ["malformed JSON", () => new Response("{broken")],
  ["empty directory", () => json({})],
  ["array directory", () => json([])],
  ["error envelope", () => json({ error: { message: "Try later" } })],
  ["mismatched provider identity", () => json({ test: provider("other", {}) })],
  ["invalid models", () => json({ test: provider("test", []) })],
  ["invalid limits", () => json({ test: provider("test", { m: model("m", { limit: { context: "huge" } }) }) })],
  ["invalid modalities", () => json({ test: provider("test", { m: model("m", { modalities: { input: "image" } }) }) })],
  ...[
    ["numeric override endpoint", { provider: { api: 42 } }],
    ["invalid override package", { provider: { npm: false } }],
    ["unknown request shape", { provider: { shape: "message" } }],
    ["array request body", { provider: { body: [] } }],
    ["numeric request header", { provider: { headers: { "x-model": 42 } } }],
    ["invalid release date", { release_date: { year: 2026 } }],
    ["nonboolean tool support", { tool_call: "yes" }],
    ["unknown model status", { status: "not-a-status" }],
  ].map(([name, metadata]) => [name, () => json({ test: provider("test", { m: model("m", metadata) }) })]),
]) {
  test(`${name} preserves the snapshot and cools down repeated callers`, async context => {
    const fetch = context.mock.method(globalThis, "fetch", response);
    const directory = await loadDirectory();
    assert.equal(await directory.refreshModelsDevProviders(), snapshot);
    assert.equal(await directory.refreshModelsDevProviders(), snapshot);
    assert.equal(directory.getModelsDevProviders(), snapshot);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test("concurrent refreshes share one SDK request and retain unreturned bundled providers", async context => {
  let complete;
  const fetch = context.mock.method(globalThis, "fetch", (_url, options) => {
    assert.equal(String(_url), "https://models.dev/api.json");
    assert.equal(options.method, "GET");
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    return new Promise(resolve => { complete = resolve; });
  });
  const directory = await loadDirectory();
  const first = directory.refreshModelsDevProviders();
  const second = directory.refreshModelsDevProviders();
  const fresh = provider("test", { m: model("m", { limit: { context: 64000, output: 8000 } }) });
  await new Promise(resolve => setImmediate(resolve));
  complete(json({ test: fresh }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(directory.getModelsDevProviders(), a);
  assert.deepEqual(a.test, fresh);
  assert.equal(a.openai, snapshot.openai);
  assert.equal(await directory.refreshModelsDevProviders(), a);
  assert.equal(fetch.mock.callCount(), 1);
});

test("failed refreshes preserve the last successful directory and recover after cooldown", async context => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  let unavailable = false;
  const fetch = context.mock.method(globalThis, "fetch", () => {
    if (unavailable) throw new Error("Offline");
    return json({ test: provider("test", { current: model("current") }) });
  });
  const directory = await loadDirectory();
  const good = await directory.refreshModelsDevProviders();
  now += 6 * 60 * 60 * 1000;
  unavailable = true;
  assert.equal(await directory.refreshModelsDevProviders(), good);
  assert.equal(await directory.refreshModelsDevProviders(), good);
  assert.equal(fetch.mock.callCount(), 2);
  now += 60_000;
  unavailable = false;
  assert.deepEqual((await directory.refreshModelsDevProviders()).test, good.test);
  assert.equal(fetch.mock.callCount(), 3);
});

test("partial and empty model lists retain bundled models and earlier successful additions", async context => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  let response = {
    deepseek: { ...snapshot.deepseek, models: { fresh: model("fresh", { limit: { context: 32000 } }) } },
    added: provider("added", { first: model("first") }),
  };
  context.mock.method(globalThis, "fetch", () => json(response));
  const directory = await loadDirectory();
  const first = await directory.refreshModelsDevProviders();
  const bundledModel = Object.keys(snapshot.deepseek.models)[0];
  assert.equal(first.deepseek.models[bundledModel], snapshot.deepseek.models[bundledModel]);
  assert.equal(first.deepseek.models.fresh.limit.context, 32000);

  now += 6 * 60 * 60 * 1000;
  response = { deepseek: { ...snapshot.deepseek, models: {} } };
  const second = await directory.refreshModelsDevProviders();
  assert.equal(second.added, first.added, "an omitted provider remains available");
  assert.deepEqual(second.deepseek.models, first.deepseek.models, "an empty models response keeps offline and previously refreshed models");

  now += 6 * 60 * 60 * 1000;
  response = { deepseek: { ...snapshot.deepseek, models: { fresh: model("fresh", { limit: { context: 64000 } }), newer: model("newer") } } };
  const third = await directory.refreshModelsDevProviders();
  assert.equal(third.deepseek.models[bundledModel], snapshot.deepseek.models[bundledModel]);
  assert.equal(third.deepseek.models.fresh.limit.context, 64000, "an explicit model record updates its prior metadata");
  assert.ok(third.deepseek.models.newer);
  assert.equal(first.deepseek.models.fresh.limit.context, 32000, "refresh does not mutate earlier readers' objects");
});

test("refresh readers keep a usable directory while pending and reject mixed valid/invalid updates atomically", async context => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  let finish;
  context.mock.method(globalThis, "fetch", () => new Promise(resolve => { finish = resolve; }));
  const directory = await loadDirectory();
  const first = directory.refreshModelsDevProviders();
  assert.equal(directory.getModelsDevProviders(), snapshot, "a pending refresh never blocks synchronous offline readers");
  await new Promise(resolve => setImmediate(resolve));
  finish(json({ added: provider("added", { first: model("first", { limit: { context: 32000 } }) }) }));
  const good = await first;

  now += 6 * 60 * 60 * 1000;
  const refresh = directory.refreshModelsDevProviders();
  assert.equal(directory.getModelsDevProviders(), good, "readers retain the last successful catalog during refresh");
  await new Promise(resolve => setImmediate(resolve));
  finish(json({
    added: provider("added", { first: model("first", { limit: { context: 64000 } }), second: model("second") }),
    broken: provider("different-id", {}),
  }));
  assert.equal(await refresh, good);
  assert.equal(directory.getModelsDevProviders().added.models.first.limit.context, 32000);
  assert.equal(directory.getModelsDevProviders().added.models.second, undefined,
    "a rejected response cannot partially overwrite valid cached models");
});

test("closing every requesting panel does not poison the shared refresh for a later panel", async context => {
  let finish;
  let networkSignal;
  const fetch = context.mock.method(globalThis, "fetch", (_url, { signal }) => {
    networkSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const directory = await loadDirectory();
  const firstPanel = new AbortController();
  const secondPanel = new AbortController();
  const first = directory.refreshModelsDevProviders(firstPanel.signal);
  const second = directory.refreshModelsDevProviders(secondPanel.signal);
  await new Promise(resolve => setImmediate(resolve));
  firstPanel.abort();
  secondPanel.abort();
  await Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  assert.equal(networkSignal.aborted, false);
  const reopened = directory.refreshModelsDevProviders();
  await new Promise(resolve => setImmediate(resolve));
  finish(json({ added: provider("added", { newest: model("newest") }) }));
  const result = await reopened;
  assert.ok(result.added.models.newest);
  assert.equal(await directory.refreshModelsDevProviders(), result);
  assert.equal(fetch.mock.callCount(), 1, "reopening joins the existing refresh and then uses its cache");
  await assert.rejects(directory.refreshModelsDevProviders(firstPanel.signal), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1, "cancellation also wins over a ready cached result");
});

test("valid routing overrides and partial modalities remain usable metadata", async context => {
  const fresh = provider("test", {
    m: model("m", {
      modalities: { input: ["text"] },
      provider: { npm: "@ai-sdk/openai", api: "https://example.test/v1", shape: "responses", body: { nested: [true, null, 3, "value"] }, headers: { "x-model": "test" } },
    }),
  });
  context.mock.method(globalThis, "fetch", () => json({ test: fresh }));
  const directory = await loadDirectory();
  assert.deepEqual((await directory.refreshModelsDevProviders()).test, fresh);
});

test("the full published snapshot satisfies the same network validation boundary", async context => {
  context.mock.method(globalThis, "fetch", () => json(snapshot));
  const directory = await loadDirectory();
  const refreshed = await directory.refreshModelsDevProviders();
  assert.notEqual(refreshed, snapshot, "a valid SDK response is accepted rather than silently falling back");
  assert.deepEqual(Object.keys(refreshed), Object.keys(snapshot));
  assert.deepEqual(refreshed.deepseek, snapshot.deepseek);
});

test("a stalled request times out and returns the offline directory", async context => {
  context.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const directory = await loadDirectory();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = directory.refreshModelsDevProviders();
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(3000);
  assert.equal(await pending, snapshot);
});

test("cancelling one caller does not abort another caller's shared refresh", async context => {
  let complete;
  let networkSignal;
  const fetch = context.mock.method(globalThis, "fetch", (_url, { signal }) => {
    networkSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  });
  const directory = await loadDirectory();
  const controller = new AbortController();
  const cancelled = directory.refreshModelsDevProviders(controller.signal);
  const survivor = directory.refreshModelsDevProviders();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(networkSignal.aborted, false);
  complete(json({ test: provider("test", {}) }));
  assert.ok((await survivor).test);
  assert.equal(fetch.mock.callCount(), 1);
});

test("already cancelled callers never initiate a refresh", async context => {
  const fetch = context.mock.method(globalThis, "fetch", () => { throw new Error("No request expected"); });
  const directory = await loadDirectory();
  await assert.rejects(directory.refreshModelsDevProviders(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("known SDK models and private fallbacks resolve without any network request", async context => {
  const fetch = context.mock.method(globalThis, "fetch", () => { throw new Error("Known models must remain offline"); });
  const { getBundledModelMaxOutputTokens, matchConfiguredModelCapabilities } = await import("../../src/shared/models/model-capabilities.js");
  const rawProvider = snapshot.abacus;
  const rawModel = Object.values(rawProvider.models).find(entry => entry.limit.output > 0);
  assert.equal(await getBundledModelMaxOutputTokens({ provider: rawProvider.id, model: rawModel.id }), rawModel.limit.output);
  assert.equal(await getBundledModelMaxOutputTokens({ provider: "opencodego", model: Object.keys(snapshot["opencode-go"].models)[0] }),
    Object.values(snapshot["opencode-go"].models)[0].limit.output);
  assert.equal(fetch.mock.callCount(), 0, "bundled output limits never wait for the network");
  assert.equal((await matchConfiguredModelCapabilities({ provider: "bailian", model: "qwen3.7-max" })).source, "models.dev");
  const miniMax = await matchConfiguredModelCapabilities({ provider: "minimaxcn", model: "MiniMax-M3" });
  assert.equal(miniMax.contextWindow, snapshot["minimax-cn"].models["MiniMax-M3"].limit.context);
  assert.notEqual(miniMax.contextWindow, 1_000_000, "the older curated context cannot shadow SDK metadata");
  assert.equal(miniMax.vision, true);
  assert.equal(miniMax.source, "models.dev");
  const codex = await matchConfiguredModelCapabilities({ provider: "openaicodex", model: "gpt-5.6-sol" });
  assert.equal(codex.contextWindow, 272000);
  assert.equal(codex.source, "qz-openai-codex-provider-metadata");
  const aliased = await matchConfiguredModelCapabilities({ provider: "opencodego", model: Object.keys(snapshot["opencode-go"].models)[0] });
  assert.equal(aliased.providerId, "opencode-go");
  assert.equal(aliased.matched, true);
  const raw = await matchConfiguredModelCapabilities({ provider: rawProvider.id, model: rawModel.id });
  assert.equal(raw.providerId, rawProvider.id);
  assert.equal(raw.contextWindow, rawModel.limit.context);
  await assert.rejects(matchConfiguredModelCapabilities({ provider: rawProvider.id, model: rawModel.id }, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0, "known models and private fallback metadata never wait for refresh");
});

test("only unknown models refresh metadata; explicit SDK capabilities win and absent fields fall back", async context => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  let response = {
    deepseek: provider("deepseek", {
      "metadata-only": model("metadata-only", { limit: { context: 64000, output: 8000 } }),
      "text-only": model("text-only", { modalities: { input: ["text"], output: ["text"] } }),
    }),
    "minimax-cn": provider("minimax-cn", {
      "MiniMax-M3": model("MiniMax-M3", { limit: { context: 64000 }, modalities: { input: ["text"] } }),
    }),
  };
  const fetch = context.mock.method(globalThis, "fetch", () => json(response));
  const { matchConfiguredModelCapabilities } = await import("../../src/shared/models/model-capabilities.js");
  const { refreshModelsDevProviders } = await import("../../src/shared/models/models-dev.js");
  const unknownVision = await matchConfiguredModelCapabilities({ provider: "deepseek", model: "metadata-only" });
  assert.equal(unknownVision.contextWindow, 64000);
  assert.equal(unknownVision.maxOutputTokens, 8000);
  assert.equal(unknownVision.vision, null);
  assert.equal(fetch.mock.callCount(), 1, "a model absent from the offline snapshot triggers discovery");
  assert.equal((await matchConfiguredModelCapabilities({ provider: "deepseek", model: "text-only" })).vision, false);
  const explicit = await matchConfiguredModelCapabilities({ provider: "minimaxcn", model: "MiniMax-M3" });
  assert.equal(explicit.contextWindow, 64000);
  assert.equal(explicit.vision, false, "explicit SDK false must not be replaced by the curated true value");
  assert.equal(fetch.mock.callCount(), 1, "subsequent known models use the refreshed local cache");

  now += 6 * 60 * 60 * 1000;
  response = { "minimax-cn": provider("minimax-cn", { "MiniMax-M3": model("MiniMax-M3", { limit: { context: 64000 } }) }) };
  await refreshModelsDevProviders();
  const partial = await matchConfiguredModelCapabilities({ provider: "minimaxcn", model: "MiniMax-M3" });
  assert.equal(partial.contextWindow, 64000);
  assert.equal(partial.vision, true, "an absent SDK field can use authoritative curated metadata");
  assert.equal((await matchConfiguredModelCapabilities({ provider: "bailian", model: "new-unlisted" })).matched, false);
  assert.equal(fetch.mock.callCount(), 2, "missing models share the successful refresh interval");
});
