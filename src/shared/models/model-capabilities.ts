import contributions from "#capabilities/modelCapabilities";
import { mergeCapabilityRecords } from "../capabilities.js";
import { PRODUCT_MODEL_CONFIGS, matchProductModelCapabilities } from '../product/model-capabilities.js';
import type { ModelCapability, ModelCapabilityMatch, ProviderModelCapabilities } from '../contracts/model-capabilities.js';
import type { Model } from "@opencode-ai/models";
import { modelsDevProviderIds, getModelsDevProviders, loadBundledModelsDevProviders, refreshModelsDevProviders } from "./models-dev.js";

interface ConfiguredModel { model?: string; provider?: string }
const K = 1024;
const ONE_MILLION = 1000000;
const ONE_MIB = 1024 * 1024;
const OFFICIAL_PROVIDER_MODEL_CONFIGS = mergeCapabilityRecords<ProviderModelCapabilities>([
  ...contributions.map(contribution => contribution.official || {}), PRODUCT_MODEL_CONFIGS,
]);
const MODELS_DEV_PROVIDER_IDS = mergeCapabilityRecords<string>(contributions.map(contribution => contribution.modelsDev || {}));

export function getOfficialProviderModelOptions(provider = "") {
  const providerConfig = getOfficialProviderConfig(provider);
  if (!providerConfig) return [];
  return providerConfig.models.map((model, index) => ({
    id: model.id,
    label: model.id,
    ownedBy: formatModelOptionMeta(model),
    priority: providerConfig.models.length - index,
  }));
}

export async function getBundledModelMaxOutputTokens({ model = "", provider = "" }: ConfiguredModel = {}) {
  const rawModel = String(model || "").trim();
  if (!rawModel) return null;
  const productMatch = matchProductModelCapabilities({ model: rawModel, provider: normalizeId(provider) });
  if (productMatch) return productMatch.maxOutputTokens;
  const matched = matchOfficialProviderModel({ model: rawModel, provider });
  if (matched || hasOfficialProviderConfig(provider)) return matched?.maxOutputTokens ?? null;
  const providerId = getModelsDevProviderId(provider);
  if (!providerId) return null;
  await loadBundledModelsDevProviders();
  const entry = getModelsDevProviders()[providerId];
  const modelEntry = entry && findConfiguredModel(entry.models, rawModel);
  return positiveNumber(modelEntry?.model.limit?.output);
}

export async function matchConfiguredModelCapabilities({ model = "", provider = "" }: ConfiguredModel = {}, signal?: AbortSignal): Promise<ModelCapabilityMatch> {
  signal?.throwIfAborted();
  const rawModel = String(model || "").trim();
  if (!rawModel) return emptyMatch();
  const providerId = getModelsDevProviderId(provider);
  const fallback = matchProductModelCapabilities({ model: rawModel, provider: normalizeId(provider) })
    || matchOfficialProviderModel({ model: rawModel, provider });
  if (!providerId) return fallback || emptyMatch();
  await loadBundledModelsDevProviders(signal);
  signal?.throwIfAborted();
  const local = matchModelsDevCapabilities(providerId, rawModel);
  if (local) return fillMissingCapabilities(local, fallback);
  if (fallback) return fallback;

  // The bundled/previously refreshed directory is authoritative for known models.
  // Only a new model absent from all local sources needs bounded online discovery.
  await refreshModelsDevProviders(signal);
  signal?.throwIfAborted();
  return matchModelsDevCapabilities(providerId, rawModel) || emptyMatch();
}

function matchModelsDevCapabilities(providerId: string, rawModel: string): ModelCapabilityMatch | null {
  const providerEntry = getModelsDevProviders()[providerId];
  if (!providerEntry) return null;
  const matched = findConfiguredModel(providerEntry.models, rawModel);
  if (!matched) return null;

  const contextWindow = positiveNumber(matched.model.limit?.context);
  const maxOutputTokens = positiveNumber(matched.model.limit?.output);
  const inputModalities = matched.model.modalities?.input;
  const vision = Array.isArray(inputModalities) ? inputModalities.includes("image") : null;

  return {
    matched: contextWindow !== null || maxOutputTokens !== null || typeof vision === "boolean",
    model: rawModel,
    matchedId: matched.id,
    contextWindow,
    maxOutputTokens,
    vision,
    source: "models.dev",
    providerId,
    providerLabel: providerEntry?.name || providerId,
  };
}

function fillMissingCapabilities(match: ModelCapabilityMatch, fallback: ModelCapabilityMatch | null): ModelCapabilityMatch {
  if (!fallback) return match;
  if (!match.matched) return fallback;
  return {
    ...match,
    contextWindow: match.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: match.maxOutputTokens ?? fallback.maxOutputTokens,
    vision: match.vision ?? fallback.vision,
  };
}

function matchOfficialProviderModel({ model, provider }: { model: string; provider: string }): ModelCapabilityMatch | null {
  const providerConfig = getOfficialProviderConfig(provider);
  if (!providerConfig) return null;
  const normalizedModel = normalizeModelId(model);
  const matched = providerConfig.models.find(item => normalizeModelId(item.id) === normalizedModel);
  if (!matched) return null;
  return {
    matched: true,
    model,
    matchedId: matched.id,
    contextWindow: matched.contextWindow ?? null,
    maxOutputTokens: matched.maxOutputTokens ?? null,
    vision: typeof matched.vision === "boolean" ? matched.vision : null,
    source: providerConfig.source,
    providerId: providerConfig.providerId,
    providerLabel: providerConfig.providerLabel,
  };
}

function hasOfficialProviderConfig(provider: string) {
  return Boolean(getOfficialProviderConfig(provider));
}

function getOfficialProviderConfig(provider: string) {
  const id = normalizeId(provider);
  return OFFICIAL_PROVIDER_MODEL_CONFIGS[id] || null;
}

function formatModelOptionMeta(model: Partial<ModelCapability> = {}) {
  const parts = [];
  if (model.contextWindow) parts.push(formatContextWindow(model.contextWindow));
  if (typeof model.vision === "boolean") parts.push(model.vision ? "image" : "text");
  return parts.join(" · ");
}

function formatContextWindow(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n === ONE_MILLION) return "1M";
  if (n === ONE_MIB) return "1M";
  const exactLabels: Readonly<Record<number, string>> = {
    262144: "262144",
    204800: "200K",
    202752: "198K",
    196608: "192K",
    131072: "128K",
    98304: "96K",
    65536: "64K",
    32768: "32K",
    16384: "16K",
    8192: "8K",
  };
  if (exactLabels[n]) return exactLabels[n];
  if (n % 1000 === 0) return `${n / 1000}K`;
  if (n % K === 0) return `${n / K}K`;
  return String(Math.round(n));
}

function getModelsDevProviderId(provider: string) {
  const id = normalizeId(provider);
  return MODELS_DEV_PROVIDER_IDS[id] || (modelsDevProviderIds.includes(id) || Object.hasOwn(getModelsDevProviders(), id) ? id : "");
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function findConfiguredModel(models: Record<string, Model>, rawModel: string) {
  const exact = Object.prototype.hasOwnProperty.call(models, rawModel)
    ? { id: rawModel, model: models[rawModel] }
    : null;
  if (exact) return exact;

  const wanted = normalizeModelId(rawModel);
  for (const [id, model] of Object.entries(models)) {
    if (normalizeModelId(id) === wanted) return { id, model };
  }
  return null;
}

function normalizeModelId(value: unknown) {
  const raw = normalizeId(value);
  const withoutWrapper = raw
    .replace(/^accounts\/[^/]+\/models\//, "")
    .replace(/^models\//, "")
    .replace(/^ark[-/]/, "")
    .replace(/\[[^\]]+\]$/, "")
    .replace(/:(free|latest|thinking|online|nitro|extended)$/i, "");
  const parts = withoutWrapper.split("/");
  return parts[parts.length - 1] || withoutWrapper;
}

function normalizeId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.0-/g, "-0-")
    .replace(/--+/g, "-");
}

function emptyMatch(): ModelCapabilityMatch {
  return {
    matched: false,
    model: "",
    matchedId: "",
    contextWindow: null,
    maxOutputTokens: null,
    vision: null,
    source: "",
    providerId: "",
    providerLabel: "",
  };
}
