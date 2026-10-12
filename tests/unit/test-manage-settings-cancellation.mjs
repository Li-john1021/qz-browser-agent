import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

await loadModelsDevFixture();

const storage = {};
const requests = [];
const events = [];
let configWrites = 0;
let onConfigRead;
let respond;

globalThis.chrome = {
  storage: { local: {
    async get(key) {
      if (key === "llmConfig") await onConfigRead?.();
      if (typeof key === "string") return { [key]: structuredClone(storage[key]) };
      if (Array.isArray(key)) return Object.fromEntries(key.map(id => [id, structuredClone(storage[id])]));
      if (key && typeof key === "object") {
        return Object.fromEntries(Object.entries(key).map(([id, fallback]) => [id, structuredClone(storage[id] ?? fallback)]));
      }
      return structuredClone(storage);
    },
    async set(values) {
      if (Object.hasOwn(values, "llmConfig")) configWrites += 1;
      Object.assign(storage, structuredClone(values));
    },
    async remove(key) {
      for (const id of Array.isArray(key) ? key : [key]) delete storage[id];
    },
  } },
};
globalThis.fetch = async (url, options = {}) => {
  const request = { url: String(url), options };
  requests.push(request);
  if (!respond) throw new Error(`Unexpected network request in cancellation test: ${request.url}`);
  return respond(request);
};

const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
const skillRuntime = await import("../../src/background/skills/skill-tool-runtime.js");
const config = await import("../../src/background/llm/config.js");
const runtimeConfig = await import("../../src/background/runtime-config.js");
const { refreshModelsDevProviders, getModelsDevProviders } = await import("../../src/shared/models/models-dev.js");
await skillRuntime.commitSkillToolRegistryCandidate(
  await skillRuntime.prepareSkillToolRegistryFromStorage(),
  { reason: "test_manage_settings_cancellation" },
);
const runtime = createToolRuntime({ emit: event => events.push(event) });
const context = { source: "test", loadedPluginSkillNames: ["qingzhou-management"] };
const manage = (input, signal) => runtime.execute(
  "qingzhou_management__manage_settings", { timeout: 30, ...input }, signal, context,
);
const aborted = error => error?.code === "OPERATION_ABORTED";
const drain = async () => { await setImmediate(); await setImmediate(); };
let baseline;
let otherPresetId;

test.beforeEach(async () => {
  onConfigRead = undefined;
  respond = undefined;
  delete storage.llmConfig;
  runtimeConfig.invalidateCurrentRuntimeConfig();
  const first = await config.saveConfig({
    provider: "openrouter", model: "openai/gpt-4o", apiKey: "cancel-fixture-key",
    contextWindow: 32000, vision: false,
  });
  otherPresetId = first.activePresetId;
  const active = await config.saveConfig({
    provider: "openrouter", model: "openai/gpt-4.1", apiKey: "cancel-fixture-key",
    contextWindow: 65536, vision: true, requestRateLimit: true,
    modelParameters: { temperature: 0.2 },
  });
  runtimeConfig.setCurrentRuntimeConfig(active);
  requests.length = 0;
  events.length = 0;
  configWrites = 0;
  baseline = {
    stored: structuredClone(storage.llmConfig),
    runtime: structuredClone(runtimeConfig.getCurrentRuntimeConfigSnapshot()),
    version: runtimeConfig.getCurrentRuntimeConfigVersion(),
  };
});

function assertUnchanged() {
  assert.equal(configWrites, 0, "cancelled work must not issue a configuration write");
  assert.deepEqual(storage.llmConfig, baseline.stored, "configuration, credentials, presets and usage must remain unchanged");
  assert.deepEqual(structuredClone(runtimeConfig.getCurrentRuntimeConfigSnapshot()), baseline.runtime);
  assert.equal(runtimeConfig.getCurrentRuntimeConfigVersion(), baseline.version, "cancelled work must not replace the runtime snapshot");
  assert.deepEqual(events.filter(event => event.type === "config"), [], "cancelled work must not broadcast a configuration change");
}

test("a pre-aborted Skill host update makes no model requests or writes", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manage({
    action: "update_config", provider: "openrouter", model: "qz-pre-aborted-unknown-model",
  }, controller.signal), aborted);
  await drain();
  assert.deepEqual(requests, []);
  assertUnchanged();
});

test("cancelled capability discovery cannot save a late successful SDK match; a new invocation can recover", { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const modelId = "qz-cancelled-discovery-model";
  respond = request => {
    assert.equal(request.url, "https://models.dev/api.json");
    entered.resolve();
    return response.promise; // Intentionally ignore abort, as a shared refresh may outlive one caller.
  };
  const controller = new AbortController();
  const pending = manage({ action: "update_config", provider: "openrouter", model: modelId }, controller.signal);
  const rejection = assert.rejects(pending, aborted);
  try {
    await entered.promise;
    controller.abort();
    await rejection;
    response.resolve(Response.json({
      openrouter: {
        id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider",
        env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1",
        models: { [modelId]: {
          id: modelId, name: modelId, tool_call: true,
          limit: { context: 64000, output: 8000 },
          modalities: { input: ["text"], output: ["text"] },
        } },
      },
    }));
    await refreshModelsDevProviders();
    await drain();
    assert.equal(getModelsDevProviders().openrouter.models[modelId].limit.context, 64000,
      "the late successful response must really reach the shared catalog");
    assert.equal(requests.length, 1);
    assertUnchanged();

    const recovered = await manage({ action: "update_config", provider: "openrouter", model: modelId });
    assert.equal(recovered.config.model, modelId);
    assert.equal(recovered.config.contextWindow, 64000);
    assert.equal(recovered.config.vision, false);
    assert.equal(configWrites, 1);
    assert.equal(requests.length, 1, "a fresh caller should use the successful shared metadata without another request");
  } finally {
    response.resolve(Response.json({}));
  }
});

test("cancelled credential validation cannot save when fetch ignores abort and later succeeds", { timeout: 5000 }, async () => {
  // SDK directories are offline-first. Opt this fixture into the host's optional
  // credential validation policy without requiring any real provider to use it.
  const provider = config.getProviderDef("zhipuai");
  const descriptors = Object.getOwnPropertyDescriptors(provider);
  const validationEndpoint = "https://validation.fixture.test/models";
  Object.defineProperties(provider, {
    modelsAuth: { value: true, configurable: true, writable: true, enumerable: true },
    modelsEndpoint: { value: validationEndpoint, configurable: true, writable: true, enumerable: true },
  });
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  let consumed = false;
  respond = request => {
    assert.equal(request.url, validationEndpoint);
    entered.resolve();
    return response.promise; // The persistence boundary must remain safe even without transport cancellation.
  };
  const controller = new AbortController();
  const pending = manage({
    action: "update_config", provider: "zhipuai", model: "GLM-5V-Turbo", apiKey: "cancelled-test-key",
  }, controller.signal);
  const rejection = assert.rejects(pending, aborted);
  try {
    await entered.promise;
    controller.abort();
    await rejection;
    assert.equal(requests[0].options.signal.aborted, true, "the Skill host must propagate cancellation into credential validation");
    response.resolve({
      ok: true, status: 200,
      async text() { consumed = true; return JSON.stringify({ data: [{ id: "GLM-5V-Turbo" }] }); },
    });
    await drain();
    assert.equal(consumed, true, "the late successful body must finish before checking durable state");
    assert.equal(requests.length, 1, "SDK-known capability matching must not make another request");
    assertUnchanged();
  } finally {
    response.resolve(Response.json({ data: [] }));
    for (const key of ["modelsAuth", "modelsEndpoint"]) {
      if (descriptors[key]) Object.defineProperty(provider, key, descriptors[key]);
      else delete provider[key];
    }
  }
});

for (const action of ["apply_preset", "delete_preset"]) {
  test(`${action} cancelled during its storage read cannot change presets or runtime`, { timeout: 5000 }, async () => {
    const entered = Promise.withResolvers();
    const read = Promise.withResolvers();
    onConfigRead = () => { entered.resolve(); return read.promise; };
    const controller = new AbortController();
    const pending = manage({ action, presetId: otherPresetId }, controller.signal);
    const rejection = assert.rejects(pending, aborted);
    try {
      await entered.promise;
      controller.abort();
      await rejection;
      read.resolve();
      await drain();
      assert.deepEqual(requests, []);
      assertUnchanged();
    } finally {
      onConfigRead = undefined;
      read.resolve();
    }
  });
}
