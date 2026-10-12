import { Models } from "@opencode-ai/models";
import type { ProviderMap } from "@opencode-ai/models";
import providerIndex from "#models-dev";
import type { ModelsDevProviderIndex } from "./models-dev-providers.js";
export { providerIds as modelsDevProviderIds } from "#models-dev";

const REQUEST_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 1000;
export const getModelsDevProviderIndex = (): Readonly<Record<string, ModelsDevProviderIndex>> => providerIndex;

export const { getModelsDevProviders, loadBundledModelsDevProviders, refreshModelsDevProviders } = createModelsDevDirectory();

/** A shared load survives individual callers closing their settings panel. */
export function createModelsDevDirectory(readSnapshot: () => Promise<unknown> = async () => {
  const response = await fetch(chrome.runtime.getURL("vendor/models-dev/providers.json"), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Model directory failed: ${response.status}`);
  return response.json();
}) {
  const client = Models.make();
  let bundledLoad: Promise<Readonly<ProviderMap>> | null = null;
  let providers: Readonly<ProviderMap> = Object.freeze({});
  let pendingRefresh: Promise<Readonly<ProviderMap>> | null = null;
  let refreshAfter = 0;

  /** Read the latest successfully loaded snapshot without starting I/O. */
  function getModelsDevProviders(): Readonly<ProviderMap> {
    return providers;
  }

  async function loadBundledModelsDevProviders(signal?: AbortSignal): Promise<Readonly<ProviderMap>> {
    signal?.throwIfAborted();
    bundledLoad ||= Promise.resolve().then(readSnapshot).then(value => {
      if (!isProviderMap(value)) throw new Error("Invalid bundled model directory");
      providers = value;
      return value;
    }).catch(error => { bundledLoad = null; throw error; });
    return withCallerSignal(bundledLoad, signal);
  }

  /** Refresh metadata only. Provider registration must keep its independently validated routing definition. */
  async function refreshModelsDevProviders(signal?: AbortSignal): Promise<Readonly<ProviderMap>> {
    await loadBundledModelsDevProviders(signal);
    signal?.throwIfAborted();
    if (!pendingRefresh && Date.now() >= refreshAfter) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      pendingRefresh = client.providers({ signal: controller.signal })
        .then(value => {
          if (!isProviderMap(value)) throw new Error("Invalid models.dev provider directory");
          // Partial responses add or replace explicit records; omitted providers and
          // models keep their last valid metadata, including the initial offline snapshot.
          providers = Object.fromEntries([
            ...Object.entries(providers),
            ...Object.entries(value).map(([id, provider]) => {
              const previous = Object.hasOwn(providers, id) ? providers[id] : undefined;
              return [id, { ...previous, ...provider, models: { ...previous?.models, ...provider.models } }];
            }),
          ]);
          refreshAfter = Date.now() + REFRESH_INTERVAL_MS;
          return providers;
        })
        .catch(() => {
          refreshAfter = Date.now() + FAILURE_COOLDOWN_MS;
          return providers;
        })
        .finally(() => {
          clearTimeout(timeout);
          pendingRefresh = null;
        });
    }
    return withCallerSignal(pendingRefresh || Promise.resolve(providers), signal);
  }
  return { getModelsDevProviders, loadBundledModelsDevProviders, refreshModelsDevProviders };
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 64) return false;
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1));
  return isRecord(value) && Object.values(value).every(item => isJson(item, depth + 1));
}

function isModelProvider(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.npm === undefined || typeof value.npm === "string")
    && (value.api === undefined || typeof value.api === "string")
    && (value.shape === undefined || value.shape === "responses" || value.shape === "completions")
    && (value.body === undefined || (isRecord(value.body) && isJson(value.body)))
    && (value.headers === undefined || (isRecord(value.headers) && Object.values(value.headers).every(header => typeof header === "string")));
}

function isProviderMap(value: unknown): value is ProviderMap {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([id, provider]) => {
    if (!id || !isRecord(provider) || provider.id !== id || typeof provider.name !== "string"
      || !provider.name || typeof provider.npm !== "string" || !provider.npm
      || !isStringArray(provider.env) || !isRecord(provider.models)
      || (provider.api !== undefined && typeof provider.api !== "string")
      || (provider.doc !== undefined && typeof provider.doc !== "string")) return false;
    return Object.entries(provider.models).every(([modelId, model]) => {
      if (!modelId || !isRecord(model) || model.id !== modelId) return false;
      if (["name", "description", "family", "knowledge", "release_date", "last_updated"].some(key => model[key] !== undefined && typeof model[key] !== "string")) return false;
      if (["attachment", "reasoning", "tool_call", "structured_output", "temperature", "open_weights"].some(key => model[key] !== undefined && typeof model[key] !== "boolean")) return false;
      if (model.status !== undefined && (typeof model.status !== "string" || !["alpha", "beta", "deprecated"].includes(model.status))) return false;
      if (model.limit !== undefined && (!isRecord(model.limit)
        || !Object.values(model.limit).every(limit => typeof limit === "number" && Number.isFinite(limit) && limit >= 0))) return false;
      if (model.modalities !== undefined && (!isRecord(model.modalities)
        || (model.modalities.input !== undefined && !isStringArray(model.modalities.input))
        || (model.modalities.output !== undefined && !isStringArray(model.modalities.output)))) return false;
      if (model.provider !== undefined && !isModelProvider(model.provider)) return false;
      return true;
    });
  });
}
