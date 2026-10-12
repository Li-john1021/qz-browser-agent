import { t } from "./i18n.js";
import { buildCodexModelListHeaders, formatCodexHttpError, resolveCodexAuth } from './auth.js';
import { resolveCodexModelsEndpoint } from './endpoints.js';
import { trace } from '#sdk/background/tools';
import type { ProviderDefinition, ProviderModelDiscovery, ProviderModelOptionEntry } from '#sdk/background/providers';

export async function listModels({ definition, signal, read, normalize }: ProviderModelDiscovery) {
  try {
    const auth = await resolveCodexAuth(signal);
    const { response, text } = await read(resolveCodexModelsEndpoint(definition.modelsEndpoint || definition.baseUrl), buildCodexModelListHeaders(auth));
    if (!response.ok) throw new Error(formatCodexHttpError(response.status, text));
    const models = normalize(JSON.parse(text));
    if (Array.isArray(models) && models.length) return models;
    throw new Error(t("openaiCodexModelsApiReturnedAnEmptyModelList"));
  } catch (error) {
    signal?.throwIfAborted();
    trace(`codex models fallback static: ${error instanceof Error ? error.message : String(error)}`);
    return definition.staticModels || [];
  }
}

export function compareModels(a: ProviderModelOptionEntry, b: ProviderModelOptionEntry, definition: Partial<ProviderDefinition>) {
  return codexModelVersionRank(b.id) - codexModelVersionRank(a.id) || modelListPriority(b, definition) - modelListPriority(a, definition);
}

function codexModelVersionRank(modelId: string) {
  const match = String(modelId || "").toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return 0;
  return Number(match[1]) * 1_000_000 + Number(match[2] || 0) * 1_000 + Number(match[3] || 0);
}

function modelListPriority(model: ProviderModelOptionEntry, providerDef: Partial<ProviderDefinition> = {}) {
  if (model?.priority != null) return model.priority;
  const id = String(model?.id || "").toLowerCase();
  const fallback = (Array.isArray(providerDef.staticModels) ? providerDef.staticModels : [])
    .find(item => typeof item === "object" && String(item?.id || "").toLowerCase() === id);
  return typeof fallback === "object" && typeof fallback?.priority === "number" ? fallback.priority : 0;
}

