import assert from "node:assert/strict";

const storageData = {};
const getCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        getCalls.push(key);
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

const runtimeConfig = await import("../../src/background/runtime-config.js");
const traceRuntime = await import("../../src/background/trace.js");

function resetStorage(config = {}) {
  for (const key of Object.keys(storageData)) delete storageData[key];
  getCalls.length = 0;
  runtimeConfig.invalidateCurrentRuntimeConfig();
  storageData.llmConfig = config;
}

resetStorage({
  provider: "deepseek",
  apiKey: "ak-1",
  model: "model-a",
  contextWindow: "32K",
  vision: true,
  debugMode: true,
});

await traceRuntime.clearTraceLog();
const first = await runtimeConfig.getCurrentRuntimeConfig();
assert.equal(first.provider, "deepseek");
assert.equal(first.model, "model-a");
assert.equal(first.contextWindow, 32000);
assert.equal(first.vision, true);
assert.equal(first.debugMode, true);
assert.equal(runtimeConfig.runtimeConfigContextWindow(), 32000);
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot(), first);
traceRuntime.trace("runtime config enabled trace");
assert.ok(
  (await traceRuntime.getTraceLog()).some(line => line.includes("runtime config enabled trace")),
  "hydrating a persisted debug setting should enable Background trace",
);
const firstReadCount = getCalls.length;
assert.ok(firstReadCount > 0, "first read should hydrate from storage");

storageData.llmConfig = {
  provider: "deepseek",
  apiKey: "ak-2",
  model: "model-b",
  contextWindow: "64K",
};
const cached = await runtimeConfig.getCurrentRuntimeConfig();
assert.equal(cached, first, "cached read should return the same central snapshot");
assert.equal(cached.contextWindow, 32000, "cached read should not silently pick up storage changes");
assert.equal(getCalls.length, firstReadCount, "cached read should not touch storage again");

const refreshed = await runtimeConfig.getCurrentRuntimeConfig({ refresh: true });
assert.notEqual(refreshed, first);
assert.equal(refreshed.model, "model-b");
assert.equal(refreshed.contextWindow, 64000);
assert.ok(getCalls.length > firstReadCount, "explicit refresh should read storage again");

const versionBeforeSet = runtimeConfig.getCurrentRuntimeConfigVersion();
const sourcePreset = { id: "p1", name: "Preset 1" };
const sourceProviderApiKeys = { custom: "secret" };
const manual = runtimeConfig.setCurrentRuntimeConfig({
  provider: "custom",
  model: "manual-model",
  contextWindow: 123456.9,
  debugMode: false,
  presets: [sourcePreset],
  providerApiKeys: sourceProviderApiKeys,
});
assert.equal(runtimeConfig.getCurrentRuntimeConfigVersion(), versionBeforeSet + 1);
assert.equal(manual.contextWindow, 123456);
assert.equal(runtimeConfig.runtimeConfigContextWindow(manual), 123456);
assert.equal(await runtimeConfig.getCurrentRuntimeConfig(), manual, "manual set should replace the read-through cache");
assert.ok(Object.isFrozen(manual), "central runtime config snapshot should be immutable at the top level");
const traceCountBeforeDisabledWrite = (await traceRuntime.getTraceLog()).length;
traceRuntime.trace("runtime config disabled trace");
assert.equal(
  (await traceRuntime.getTraceLog()).length,
  traceCountBeforeDisabledWrite,
  "applying debugMode=false should stop new Background trace writes without erasing existing logs",
);

sourcePreset.name = "mutated";
sourceProviderApiKeys.custom = "changed";
assert.equal(
  runtimeConfig.getCurrentRuntimeConfigSnapshot().presets[0].name,
  "Preset 1",
  "preset entries should be copied into the snapshot so caller mutations cannot leak in",
);
assert.equal(
  runtimeConfig.getCurrentRuntimeConfigSnapshot().providerApiKeys.custom,
  "secret",
  "provider API key map should be copied into the snapshot so caller mutations cannot leak in",
);

runtimeConfig.invalidateCurrentRuntimeConfig();
const versionAfterInvalidate = runtimeConfig.getCurrentRuntimeConfigVersion();
assert.notEqual(runtimeConfig.getCurrentRuntimeConfigSnapshot(), manual);
assert.equal(runtimeConfig.runtimeConfigContextWindow(), 0);
assert.ok(versionAfterInvalidate > versionBeforeSet + 1);

console.log("runtime config tests passed");
