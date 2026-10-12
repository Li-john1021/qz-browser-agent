import { getModelsDevProviderIndex, getModelsDevProviders, loadBundledModelsDevProviders, modelsDevProviderRoute, compatibleModelsDevModels, type ModelsDevProviderIndex } from "#sdk/background/models";
import type { ProviderDefinition } from "#sdk/background/providers";
import { t } from "./i18n.js";

const group = { id: "all", get label() { return t("allProviders"); }, priority: 100 };
/** Catalog data describes services, not executable adapters. Only routes our protocols
 * can send with one API key are offered; special auth remains in its owning package. */
export function createModelsDevPresets(aliases: Readonly<Record<string, string>>, directory: Readonly<Record<string, ModelsDevProviderIndex>> = getModelsDevProviderIndex()) {
  const stableIds = new Map<string, string>();
  for (const [id, sdkId] of Object.entries(aliases)) {
    if (!id.trim() || !sdkId.trim()) throw new Error("Empty models.dev provider alias");
    if (stableIds.has(sdkId)) throw new Error(`Duplicate models.dev alias target: ${sdkId}`);
    stableIds.set(sdkId, id);
  }
  return Object.fromEntries(Object.entries(directory).flatMap(([sdkId, provider]) => {
    const id = stableIds.get(sdkId) || sdkId;
    // Existing IDs own their credential destination. For example, legacy moonshotai
    // means the China service, so the SDK's international namesake cannot claim it.
    if (Object.hasOwn(aliases, id) && aliases[id] !== sdkId) return [];
    const route = provider;
    const definition: ProviderDefinition = {
      label: provider.name, group,
      protocol: route.protocol,
      api: route.protocol === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
      endpoint: route.endpoint,
      modelsAuth: false,
      ...(route.protocol === "anthropic" ? { anthropicVersion: "2023-06-01", modelsAuthHeader: "x-api-key" } : {}),
      staticModelCount: provider.modelCount,
      async listModels({ signal }) {
        signal?.throwIfAborted();
        const bundled = await loadBundledModelsDevProviders(signal);
        signal?.throwIfAborted();
        const models = compatibleModelsDevModels(bundled[sdkId]);
        const updated = getModelsDevProviders()[sdkId];
        // Online metadata may update models, never silently redirect saved credentials.
        const nextRoute = updated && modelsDevProviderRoute(updated);
        if (!nextRoute || nextRoute.endpoint !== route.endpoint || nextRoute.protocol !== route.protocol) return models;
        const nextModels = compatibleModelsDevModels(updated);
        return nextModels.length ? nextModels : models;
      },
    };
    return [[id, definition]];
  }));
}
