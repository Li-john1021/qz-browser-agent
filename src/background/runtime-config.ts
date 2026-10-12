import type { RuntimeConfig } from "../sdk/background/providers.js";
import { getConfig } from "./llm/index.js";
import { setTraceDebugMode } from "./trace.js";

let runtimeConfigSnapshot: Readonly<RuntimeConfig> | null = null;
let runtimeConfigPromise: Promise<Readonly<RuntimeConfig>> | null = null;
let runtimeConfigVersion = 0;

export async function getCurrentRuntimeConfig({ refresh = false } = {}) {
  if (refresh || !runtimeConfigPromise) {
    runtimeConfigPromise = getConfig()
      .then((config) => setCurrentRuntimeConfig(config))
      .catch((err) => {
        runtimeConfigPromise = null;
        throw err;
      });
  }
  return runtimeConfigPromise;
}

export function setCurrentRuntimeConfig(config: RuntimeConfig = {}) {
  setTraceDebugMode(config.debugMode === true);
  runtimeConfigSnapshot = freezeRuntimeConfig(config);
  runtimeConfigVersion += 1;
  runtimeConfigPromise = Promise.resolve(runtimeConfigSnapshot);
  return runtimeConfigSnapshot;
}

export function invalidateCurrentRuntimeConfig() {
  runtimeConfigSnapshot = null;
  runtimeConfigPromise = null;
  runtimeConfigVersion += 1;
}

export function getCurrentRuntimeConfigSnapshot() {
  return runtimeConfigSnapshot;
}

export function getCurrentRuntimeConfigVersion() {
  return runtimeConfigVersion;
}

export function runtimeConfigContextWindow(config: RuntimeConfig | null = runtimeConfigSnapshot) {
  const value = Number(config?.contextWindow);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function freezeRuntimeConfig(config: RuntimeConfig = {}) {
  const presets = Array.isArray(config.presets)
    ? config.presets.map((preset: unknown) => ({ ...record(preset) }))
    : [];
  const providerApiKeys = config.providerApiKeys && typeof config.providerApiKeys === "object"
    ? { ...config.providerApiKeys }
    : {};
  return Object.freeze({
    ...config,
    contextWindow: Math.max(0, Math.floor(Number(config.contextWindow) || 0)),
    trimOldToolResults: config.trimOldToolResults !== false,
    presets,
    providerApiKeys,
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
