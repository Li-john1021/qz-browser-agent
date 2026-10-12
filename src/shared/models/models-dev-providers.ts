import type { Model, Provider, ProviderMap } from "@opencode-ai/models";

export interface ModelsDevProviderIndex {
  name: string;
  protocol: "openai" | "anthropic";
  endpoint: string;
  modelCount: number;
}

const protocols: Readonly<Record<string, "openai" | "anthropic">> = {
  "@ai-sdk/openai-compatible": "openai",
  "@openrouter/ai-sdk-provider": "openai",
  "@ai-sdk/anthropic": "anthropic",
};

/** Build the small routing index from the same rules used for model discovery. */
export function createModelsDevProviderIndex(directory: Readonly<ProviderMap>): Record<string, ModelsDevProviderIndex> {
  return Object.fromEntries(Object.entries(directory).flatMap(([id, provider]) => {
    const route = modelsDevProviderRoute(provider);
    const modelCount = compatibleModelsDevModels(provider).length;
    return route && modelCount ? [[id, { name: provider.name, ...route, modelCount }]] : [];
  }));
}

export function modelsDevProviderRoute(provider: Provider) {
  const protocol = protocols[provider.npm];
  if (!protocol || provider.env.length !== 1 || provider.id === "github-copilot") return null;
  const api = provider.api || (provider.id === "anthropic" ? "https://api.anthropic.com/v1" : "");
  if (!api || /[${}]/u.test(api)) return null;
  try {
    const url = new URL(api);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    const root = url.href.replace(/\/+$/u, "");
    const suffix = protocol === "anthropic" ? "/messages" : "/chat/completions";
    return { protocol, endpoint: root.endsWith(suffix) ? root : root + suffix };
  } catch { return null; }
}

export function compatibleModelsDevModels(provider: Provider) {
  return Object.values(provider.models).filter(model => isCompatibleModel(provider, model)).map(model => ({
    id: model.id, label: model.name || model.id, releaseDate: model.release_date,
  }));
}

function isCompatibleModel(provider: Provider, model: Model) {
  if (model.tool_call !== true || model.status === "deprecated" || !model.modalities?.input?.includes("text") || !model.modalities?.output?.includes("text")) return false;
  const override = model.provider;
  // Per-model routes and request overrides need explicit adapter support.
  return !override || (
    (!override.npm || protocols[override.npm] === protocols[provider.npm]
      || (override.npm === "@ai-sdk/openai" && override.shape === "completions" && protocols[provider.npm] === "openai"))
    && (!override.api || override.api.replace(/\/+$/u, "") === provider.api?.replace(/\/+$/u, ""))
    && (!override.shape || override.shape === "completions")
    && !Object.keys(override.body || {}).length && !Object.keys(override.headers || {}).length
  );
}
