import assert from "node:assert/strict";
import test from "node:test";
import { providers as snapshot } from "@opencode-ai/models/snapshot";
import { createModelsDevPresets as createIndexedPresets } from "../../src/capabilities/models/models-dev-presets.js";
import { PROVIDERS, getProviderDef, listProviderSummaries, normalizeProvider } from "../../src/background/llm/provider-catalog.js";
import { listProviderModels } from "../../src/background/llm/model-directory.js";
import { createLlmGateway } from "../../src/background/llm/index.js";
import { getConfig, saveConfig, applyModelPreset } from "../../src/background/llm/config.js";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";
import { matchConfiguredModelCapabilities } from "../../src/shared/models/model-capabilities.js";
import { refreshModelsDevProviders } from "../../src/shared/models/models-dev.js";
import { groupProviderChoices } from "../../src/shared/settings-menu-utils.js";
import modelCapabilities from "../../src/capabilities/models/model-capabilities.js";

import { createModelsDevProviderIndex, compatibleModelsDevModels } from "../../src/shared/models/models-dev-providers.js";
import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
await loadModelsDevFixture();
const createModelsDevPresets = (aliases, directory = snapshot) => createIndexedPresets(aliases, createModelsDevProviderIndex(directory));

const model = (id, extra = {}) => ({ id, name: id, tool_call: true, modalities: { input: ["text"], output: ["text"] }, ...extra });
const provider = (id, extra = {}) => ({
  id, name: id, npm: "@ai-sdk/openai-compatible", env: ["EXAMPLE_API_KEY"],
  api: "https://example.test/v1", models: { chat: model("chat") }, ...extra,
});
const directory = (...entries) => Object.fromEntries(entries.map(entry => [entry.id, entry]));
const presets = (...entries) => createModelsDevPresets({}, directory(...entries));

test("the full snapshot owns ordinary provider routes, labels and model lists under stable IDs", () => {
  const generated = createModelsDevPresets(modelCapabilities.modelsDev);
  assert.ok(Object.keys(generated).length > 100);
  for (const [id, definition] of Object.entries(generated)) {
    const entry = snapshot[modelCapabilities.modelsDev[id] || id];
    assert.equal(definition.label, entry.name);
    assert.equal(definition.modelsAuth, false, "ordinary services use offline model suggestions without credential discovery");
    assert.equal(definition.staticModelCount, compatibleModelsDevModels(entry).length);
    assert.ok(definition.staticModelCount > 0);
  }
  assert.equal(generated.bailian.endpoint, `${snapshot["alibaba-cn"].api}/chat/completions`);
  assert.equal(generated.volcengine.endpoint, `${snapshot.volcengine.api}/chat/completions`);
  assert.equal(generated.minimaxcn.endpoint, `${snapshot["minimax-cn"].api}/messages`);
  assert.equal(generated.minimaxcn.protocol, "anthropic");
  assert.equal(generated.minimaxcn.modelsAuthHeader, "x-api-key");
  assert.equal(generated.kimicode.protocol, "openai", "protocol adjustments belong to explicit capabilities, not the SDK factory");
});

test("the registered directory retains special policies and only the three product groups", () => {
  const catalog = listProviderSummaries().filter(item => snapshot[item.id]);
  assert.ok(catalog.length > 100);
  assert.ok(catalog.every(item => snapshot[item.id] && normalizeProvider(item.id) === item.id));
  assert.ok(PROVIDERS.anthropic);
  assert.ok(PROVIDERS.openrouter);
  assert.equal(PROVIDERS.opencodego.sessionAffinityHeader, "x-opencode-session");
  assert.deepEqual(PROVIDERS.deepseek.requestDefaults.thinking, { type: "enabled" });
  assert.equal(PROVIDERS["fireworks-ai"], undefined, "existing services must not appear twice under SDK aliases");
  const groups = groupProviderChoices(listProviderSummaries(), "en");
  assert.equal(groups.at(-1).id, "all");
  const preferred = listProviderSummaries().filter(provider => provider.group?.id === "preferred");
  assert.deepEqual(groups.map(group => group.id), preferred.length ? ["preferred", "custom", "all"] : ["custom", "all"]);
  if (preferred.length) {
    assert.equal(groups[0].id, "preferred");
    assert.deepEqual(groups[0].providers.map(provider => provider.id).sort(), preferred.map(provider => provider.id).sort());
  }
});

test("aliases preserve identity without maintaining another provider definition", () => {
  const sdk = provider("sdk-provider", {
    name: "SDK-owned label", api: "https://sdk.example/v3", models: { latest: model("latest") },
  });
  const generated = createModelsDevPresets({ legacy: sdk.id, unchanged: "unchanged" }, directory(sdk, provider("unchanged")));
  assert.deepEqual(Object.keys(generated), ["legacy", "unchanged"]);
  assert.equal(generated.legacy.label, sdk.name);
  assert.equal(generated.legacy.endpoint, "https://sdk.example/v3/chat/completions");
  assert.equal(generated.legacy.staticModelCount, 1);
  assert.equal(generated["sdk-provider"], undefined, "aliases must not create duplicate menu entries");
});

test("a retained domestic ID cannot be claimed by an SDK international namesake", () => {
  const aliases = { moonshotai: "moonshotai-cn" };
  const international = provider("moonshotai", { api: "https://api.moonshot.ai/v1" });
  const domestic = provider("moonshotai-cn", { name: "Moonshot AI (China)", api: "https://api.moonshot.cn/v1" });
  for (const entries of [[international, domestic], [domestic, international]]) {
    const generated = createModelsDevPresets(aliases, directory(...entries));
    assert.deepEqual(Object.keys(generated), ["moonshotai"]);
    assert.equal(generated.moonshotai.endpoint, "https://api.moonshot.cn/v1/chat/completions");
    assert.equal(generated.moonshotai.label, domestic.name);
  }
  assert.deepEqual(createModelsDevPresets(aliases, directory(international)), {},
    "a missing alias destination must not redirect saved credentials to the same-named foreign service");
  assert.deepEqual(createModelsDevPresets(aliases, directory(international, { ...domestic, models: {} })), {},
    "an unsupported alias destination must not release its reserved identity");
});

test("ambiguous and empty aliases fail explicitly", () => {
  assert.throws(() => createModelsDevPresets({ first: "sdk", second: "sdk" }, directory(provider("sdk"))),
    /Duplicate models\.dev alias target: sdk/);
  assert.throws(() => createModelsDevPresets({ "": "sdk" }, {}), /Empty models\.dev provider alias/);
  assert.throws(() => createModelsDevPresets({ legacy: "" }, {}), /Empty models\.dev provider alias/);
});

test("legacy provider IDs preserve saved presets, credentials, usage and manual models without storage migration", async context => {
  const keys = {
    moonshotai: "legacy-domestic-moonshot-key", bailian: "legacy-bailian-key",
    kimicode: "legacy-kimicode-key", minimaxcn: "legacy-minimax-key",
  };
  const endpoints = {
    moonshotai: "https://api.moonshot.cn/v1/chat/completions",
    bailian: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    kimicode: "https://api.kimi.com/coding/v1/messages",
    minimaxcn: "https://api.minimaxi.com/anthropic/v1/messages",
  };
  const savedPresets = Object.entries(keys).map(([provider, apiKey], index) => ({
    id: `legacy-preset-${provider}`, name: `Saved ${provider}`, provider, apiKey,
    model: `legacy-${provider}-manual-model`, contextWindow: 32000 + index * 1000,
    vision: index % 2 === 0, modelParameters: { temperature: 0.2 }, updatedAt: "2026-01-01 12:00:00",
  }));
  const usage = {
    selections: Object.fromEntries(savedPresets.map((preset, index) => [preset.id, index + 2])),
    transitions: { [savedPresets[0].id]: { [savedPresets[1].id]: 3, [savedPresets[2].id]: 5 } },
  };
  const { id: activePresetId, name: _name, ...active } = savedPresets[0];
  const storage = { llmConfig: {
    ...active, activePresetId, presets: savedPresets, providerApiKeys: keys, presetUsage: usage,
    requestRateLimit: true, debugMode: false,
  } };
  const original = structuredClone(storage.llmConfig);
  let writes = 0;
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    async get(key) {
      if (typeof key === "string") return { [key]: structuredClone(storage[key]) };
      if (Array.isArray(key)) return Object.fromEntries(key.map(id => [id, structuredClone(storage[id])]));
      return Object.fromEntries(Object.entries(key || storage).map(([id, fallback]) => [id, structuredClone(storage[id] ?? fallback)]));
    },
    async set(values) { writes += 1; Object.assign(storage, structuredClone(values)); },
  } } } });
  context.after(() => {
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else delete globalThis.chrome;
  });
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Legacy configuration checks must stay offline"); });
  const assertPreserved = config => {
    assert.deepEqual(config.providerApiKeys, keys, "SDK aliases must not rename, discard or exchange stored credentials");
    assert.deepEqual(config.presets.map(preset => preset.id).sort(), savedPresets.map(preset => preset.id).sort());
    for (const expected of savedPresets) {
      const actual = config.presets.find(preset => preset.id === expected.id);
      for (const field of ["provider", "model", "apiKey", "contextWindow", "vision"]) {
        assert.equal(actual[field], expected[field], `${expected.id} retains ${field}`);
      }
      assert.equal(Object.hasOwn(snapshot[modelCapabilities.modelsDev[expected.provider]].models, expected.model), false,
        "the fixture must exercise manual models absent from the SDK suggestions");
    }
    assert.equal(config.apiKey, keys[config.provider]);
    assert.equal(config.endpoint, endpoints[config.provider]);
  };

  const loaded = await getConfig();
  assertPreserved(loaded);
  assert.equal(loaded.provider, "moonshotai");
  assert.equal(loaded.activePresetId, activePresetId);
  assert.deepEqual(loaded.presetUsage, usage);
  assert.equal(writes, 0, "reading aliases must not migrate storage");
  assert.deepEqual(storage.llmConfig, original);

  const saved = await saveConfig({ debugMode: true });
  assertPreserved(saved);
  assert.equal(saved.activePresetId, activePresetId, "saving an existing manual model must reuse its preset ID");
  assert.deepEqual(saved.presetUsage, usage);
  assert.equal(saved.requestRateLimit, true);
  assert.equal(writes, 1);

  const expectedUsage = structuredClone(usage);
  let previousId = activePresetId;
  for (const preset of [...savedPresets.slice(1), savedPresets[0]]) {
    const applied = await applyModelPreset(preset.id);
    expectedUsage.selections[preset.id] += 1;
    const transitions = expectedUsage.transitions[previousId] ||= {};
    transitions[preset.id] = (transitions[preset.id] || 0) + 1;
    assertPreserved(applied);
    assert.equal(applied.provider, preset.provider);
    assert.equal(applied.model, preset.model);
    assert.equal(applied.activePresetId, preset.id);
    assert.deepEqual(applied.presetUsage, expectedUsage, "old usage survives and only the actual selection is incremented");
    assert.equal(applied.debugMode, true);
    previousId = preset.id;
  }
  assertPreserved(await getConfig());
  assert.equal(storage.llmConfig.provider, "moonshotai");
  assert.deepEqual(storage.llmConfig.providerApiKeys, keys);
  assert.equal(writes, 5);
  assert.equal(fetch.mock.callCount(), 0, "reading, saving and applying existing configuration must not request any provider");
});

test("special auth, templated endpoints and default Responses adapters are not advertised as chat services", () => {
  const entries = [
    provider("valid"), provider("github-copilot"),
    provider("aws", { npm: "@ai-sdk/amazon-bedrock" }),
    provider("responses", { npm: "@ai-sdk/openai" }),
    provider("multi-secret", { env: ["ACCOUNT", "KEY"] }),
    provider("template", { api: "https://service.test/${ACCOUNT}/v1" }),
    provider("credentials", { api: "https://user:secret@service.test/v1" }),
    provider("query", { api: "https://service.test/v1?key=secret" }),
    provider("local", { api: "http://localhost:8080/v1" }),
    provider("invalid", { api: "garbage" }),
  ];
  assert.deepEqual(Object.keys(presets(...entries)), ["valid"]);
});

test("model-specific routes and non-agent modalities cannot silently use the provider's default route", () => {
  const entries = [
    model("valid"), model("image", { modalities: { input: ["text"], output: ["image"] } }),
    model("partial", { modalities: { input: ["text"] } }),
    model("no-tools", { tool_call: false }), model("retired", { status: "deprecated" }),
    model("other-protocol", { provider: { npm: "@ai-sdk/anthropic" } }),
    model("default-responses", { provider: { npm: "@ai-sdk/openai" } }),
    model("explicit-completions", { provider: { npm: "@ai-sdk/openai", shape: "completions" } }),
    model("responses", { provider: { shape: "responses" } }),
    model("other-api", { provider: { api: "https://other.test/v1" } }),
    model("body", { provider: { body: { special: true } } }),
    model("headers", { provider: { headers: { "x-special": "required" } } }),
  ];
  const mixed = provider("mixed", { models: Object.fromEntries(entries.map(entry => [entry.id, entry])) });
  assert.equal(presets(mixed).mixed.staticModelCount, 2);
  assert.deepEqual(compatibleModelsDevModels(mixed).map(item => item.id), ["valid", "explicit-completions"]);
  assert.deepEqual(presets(provider("empty", { models: {} })), {});
});

test("routes preserve complete endpoints and use the correct Anthropic messages path", () => {
  assert.equal(presets(provider("full", { api: "https://example.test/v1/chat/completions/" })).full.endpoint, "https://example.test/v1/chat/completions");
  const anthropic = presets(provider("anthropic", { api: undefined, npm: "@ai-sdk/anthropic" })).anthropic;
  assert.equal(anthropic.endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic.protocol, "anthropic");
});

test("SDK outages still allow catalog model selection and capability lookup through the Background API", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new TypeError("Offline fixture"); });
  const selected = listProviderSummaries().find(item => item.id === "openrouter");
  const models = await listProviderModels(selected.id, getProviderDef(selected.id), "");
  assert.ok(models.models.length > 100);
  const chosen = models.models.find(item => snapshot.openrouter.models[item.id]?.limit.context > 0);
  const replies = [];
  const transport = createSidepanelTransport({ system: { ready() {} }, config: { matchModelCapabilities: matchConfiguredModelCapabilities } });
  await transport.dispatch({ type: "match_model_capabilities", requestId: "fixture", provider: "openrouter", model: chosen.id }, { postMessage: reply => replies.push(reply) });
  assert.equal(replies[0].requestId, "fixture");
  assert.equal(replies[0].type, "model_capabilities");
  assert.equal(replies[0].match.contextWindow, snapshot.openrouter.models[chosen.id].limit.context);
  assert.equal(fetch.mock.callCount(), 0, "known model lists and metadata use the offline snapshot without requesting a refresh");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(listProviderModels(selected.id, getProviderDef(selected.id), "", abort.signal), { name: "AbortError" });
});

test("every advertised SDK model has offline capabilities under its registered provider identity", async context => {
  const fetch = context.mock.method(globalThis, "fetch", () => { throw new TypeError("The entire directory is offline"); });
  const generated = createModelsDevPresets(modelCapabilities.modelsDev);
  let modelCount = 0;
  for (const [id, definition] of Object.entries(generated)) {
    const sdkId = modelCapabilities.modelsDev[id] || id;
    const result = await listProviderModels(id, definition, "");
    assert.ok(result.models.length > 0, `${id} retains offline suggestions`);
    assert.equal(new Set(result.models.map(model => model.id)).size, result.models.length);
    for (const option of result.models) {
      const expected = snapshot[sdkId].models[option.id];
      const match = await matchConfiguredModelCapabilities({ provider: id, model: option.id });
      assert.equal(match.providerId, sdkId, `${id}/${option.id} uses the correct aliased provider`);
      assert.equal(match.matchedId, option.id, `${id}/${option.id} uses the exact model identity`);
      assert.equal(match.matched, true, `${id}/${option.id} has usable offline metadata`);
      if (expected.limit?.context > 0) assert.equal(match.contextWindow, expected.limit.context);
      assert.equal(match.vision, expected.modalities.input.includes("image"));
      modelCount += 1;
    }
  }
  assert.ok(Object.keys(generated).length > 100);
  assert.ok(modelCount > 1000, "exercise the full shipped directory rather than a sample of providers");
  assert.equal(fetch.mock.callCount(), 0, "even unavailable network is never touched by known-model selection");
  context.diagnostic(`Verified ${Object.keys(generated).length} providers and ${modelCount} models offline`);
});

for (const [id, path, auth] of [["openrouter", "/api/v1/chat/completions", "authorization"], ["anthropic", "/v1/messages", "x-api-key"]]) {
  test(`registered ${id} uses its real protocol and fixture credentials at the gateway boundary`, async context => {
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push({ url: new URL(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return Response.json(id === "anthropic"
        ? { id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    });
    const gateway = createLlmGateway({ rateGovernor: null, rateLearning: null });
    const result = await gateway.chat([{ role: "user", content: "fixture" }], [], undefined, {
      config: { provider: id, apiKey: "fixture-key", model: "fixture-model" },
      sessionId: "fixture-session", rateLimit: false, retry: { maxRetries: 0 },
    });
    assert.equal(result.message.content, "ok");
    assert.equal(requests.length, 1, "inference does not fetch catalog metadata");
    assert.equal(requests[0].url.pathname, path);
    assert.equal(requests[0].headers.get(auth), id === "anthropic" ? "fixture-key" : "Bearer fixture-key");
    assert.equal(requests[0].body.model, "fixture-model");
  });
}

test("model lists use refreshed local metadata without fetching again or changing credential routes", async context => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const definition = getProviderDef("openrouter");
  const aliased = createModelsDevPresets({ legacyrouter: "openrouter" }).legacyrouter;
  const endpoint = definition.endpoint;
  let entry = { ...snapshot.openrouter, models: { "fresh-model": model("fresh-model") } };
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ openrouter: entry }));
  await refreshModelsDevProviders();
  const result = await listProviderModels("openrouter", definition, "");
  assert.ok(result.models.some(item => item.id === "fresh-model"));
  const aliasedResult = await listProviderModels("legacyrouter", aliased, "");
  assert.ok(aliasedResult.models.some(item => item.id === "fresh-model"), "refresh lookup must use the SDK ID even when the registered ID differs");
  assert.equal(fetch.mock.callCount(), 1, "reading a populated local directory never schedules another request");
  assert.equal(definition.endpoint, endpoint);

  now += 6 * 60 * 60 * 1000;
  entry = { ...entry, api: "https://changed.example/v1", models: { "redirected-model": model("redirected-model") } };
  await refreshModelsDevProviders();
  const redirected = await listProviderModels("openrouter", definition, "");
  assert.ok(!redirected.models.some(item => item.id === "redirected-model"));
  const aliasedRedirect = await listProviderModels("legacyrouter", aliased, "");
  assert.ok(!aliasedRedirect.models.some(item => item.id === "redirected-model"));
  assert.equal(aliased.endpoint, endpoint);
  assert.equal(definition.endpoint, endpoint, "online metadata cannot redirect saved API credentials");
  assert.equal(fetch.mock.callCount(), 2);
});
