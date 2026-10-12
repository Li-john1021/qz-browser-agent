import { prepareModelImages } from './image-budget.js';
import { t } from "../../shared/i18n/backend.js";
import contributions from "#capabilities/providers";
import { mergeCapabilityRecords } from "../../shared/capabilities.js";
/** Stable LLM gateway over protocol-specific adapters. */

import { formatTraceFields, trace } from "../trace.js";
import {
  getProviderDef,
  buildProviderBaseHeaders,
  getProviderEndpoint,
  normalizeProvider,
  providerRequiresApiKey,
  resolveRequestConfig,
} from "./config.js";
import { createProviderRegistry } from "./protocol-registry.js";
import { attachProviderRecovery } from "./provider-recovery.js";
export { createProviderRegistry } from "./protocol-registry.js";
import { createProviderRateGovernor } from "./provider-rate-governor.js";
import { createProviderRateLearningRuntime } from "./provider-rate-runtime.js";
import { normalizeLlmFailure } from "./provider-errors.js";
import {
  contextTokensFromUsage,
  estimateTokens,
  estimateToolSchemaTokens,
} from "./token-accounting.js";

export { clearTraceLog, getTraceLog, trace } from "../trace.js";
export { getProviderAuthStatus, startProviderLogin, pollProviderLogin, clearProviderAuth } from "./provider-auth.js";
export {
  applyModelPreset,
  deleteModelPreset,
  formatProviderModelName,
  getConfig,
  listModels,
  listProviderSummaries,
  saveConfig,
  saveModelPreset,
  setModelChangeObserver,
} from "./config.js";

import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { ModelMessage, ModelOptions, ModelEvent, ProviderAdapter } from './protocol-registry.js';
import type { LlmFailure } from './provider-errors.js';
import type { RateAdmission } from './provider-rate-runtime.js';
type LearningRuntime = Partial<ReturnType<typeof createProviderRateLearningRuntime>> | null | undefined;
interface GatewayOptions {
  rateGovernor?: Partial<ReturnType<typeof createProviderRateGovernor>> | null;
  rateLearning?: LearningRuntime;
  rateLearningStorage?: NonNullable<Parameters<typeof createProviderRateLearningRuntime>[0]>['storage'];
  adapters?: Readonly<Record<string, ProviderAdapter>>;
  protocolRegistry?: ReturnType<typeof createProviderRegistry>;
  resolveConfig?: (options: ModelOptions) => Promise<RuntimeConfig>;
}

export const BUILTIN_PROVIDER_ADAPTERS = mergeCapabilityRecords<ProviderAdapter>(contributions);

export function createLlmGateway({
  rateGovernor = createProviderRateGovernor({ onTrace: traceProviderRate }),
  rateLearning = undefined,
  rateLearningStorage = globalThis.chrome?.storage?.local,
  adapters = BUILTIN_PROVIDER_ADAPTERS,
  protocolRegistry = createProviderRegistry(adapters),
  resolveConfig = resolveRequestConfig,
}: GatewayOptions = {}) {
  const learningRuntime = rateLearning === undefined && rateGovernor
    ? createProviderRateLearningRuntime({
      storage: rateLearningStorage,
      governor: rateGovernor,
      onTrace: traceProviderRateLearning,
    })
    : rateLearning;

  async function chat(messages: ModelMessage[], tools: object[], signal?: AbortSignal, options: ModelOptions = {}) {
    messages = await prepareModelImages(messages, signal);
    const config = await resolveConfig(options);
    const providerDefinition = getProviderDef(config);
    const adapter = protocolRegistry.get(providerDefinition.protocol);
    assertApiKey(config);
    const admission = await createRateAdmission({
      rateLearning: learningRuntime,
      config,
      messages,
      tools,
      signal,
      options,
    });
    try {
      const result = await adapter.chat(messages, tools, signal, { ...admission.options, providerDefinition, baseHeaders: buildProviderBaseHeaders(providerDefinition, options) }, config);
      await settleRateAdmission(learningRuntime, admission, result?.usage || result?.message?._usage);
      return result;
    } catch (error) {
      const failure = adapterFailure(error, "chat", adapter, config);
      await recordRateFailure(learningRuntime, admission, failure);
      throw failure;
    }
  }

  async function* chatStream(messages: ModelMessage[], tools: object[], signal?: AbortSignal, options: ModelOptions = {}): AsyncGenerator<ModelEvent> {
    messages = await prepareModelImages(messages, signal);
    const config = await resolveConfig(options);
    const providerDefinition = getProviderDef(config);
    const adapter = protocolRegistry.get(providerDefinition.protocol);
    assertApiKey(config);
    const admission = await createRateAdmission({
      rateLearning: learningRuntime,
      config,
      messages,
      tools,
      signal,
      options,
    });
    let lastUsage: Record<string, unknown> | null = null;
    let completed = false;
    try {
      for await (const chunk of adapter.chatStream(messages, tools, signal, { ...admission.options, providerDefinition, baseHeaders: buildProviderBaseHeaders(providerDefinition, options) }, config)) {
        if ("usage" in chunk && chunk.usage) lastUsage = chunk.usage;
        if (chunk.type === "done" && chunk.message._usage) lastUsage = chunk.message._usage;
        if (chunk?.type === "done") completed = true;
        yield chunk;
      }
    } catch (error) {
      const failure = adapterFailure(error, "stream", adapter, config);
      await recordRateFailure(learningRuntime, admission, failure);
      throw failure;
    } finally {
      if (completed) await settleRateAdmission(learningRuntime, admission, lastUsage);
    }
  }

  return Object.freeze({ chat, chatStream, listCustomProtocols: () => protocolRegistry.customProtocols });
}

function traceProviderRate(event: Record<string, unknown> = {}) {
  trace(`provider_rate${formatTraceFields(event)}`);
}

function traceProviderRateLearning(event: Record<string, unknown> = {}) {
  trace(`provider_rate_learning${formatTraceFields(event)}`);
}

const defaultGateway = createLlmGateway();

export const chat = defaultGateway.chat;
export const chatStream = defaultGateway.chatStream;
export const listCustomProtocols = defaultGateway.listCustomProtocols;

async function createRateAdmission({ rateLearning, config, messages, tools, signal, options }: {rateLearning: LearningRuntime; config: RuntimeConfig; messages: ModelMessage[]; tools: object[]; signal?: AbortSignal; options: ModelOptions}): Promise<RateAdmission> {
  if (options.rateLimit === false || typeof rateLearning?.beginRequest !== "function") {
    return { options, current: null };
  }
  return rateLearning.beginRequest({
    key: providerRateKey(config),
    estimatedTokens: resolveInputTokenEstimate(messages, tools, options),
    enforce: config.requestRateLimit === true,
    signal,
    onWait: options.onRateWait,
    options,
    ...rateIdentity(options),
  });
}

async function settleRateAdmission(rateLearning: LearningRuntime, admission: RateAdmission, usage: unknown) {
  if (!admission?.current?.id) return false;
  const reportedTokens = contextTokensFromUsage(usage);
  if (typeof rateLearning?.settleRequest !== "function") return false;
  return rateLearning.settleRequest({ admission, reportedTokens });
}

async function recordRateFailure(rateLearning: LearningRuntime, admission: RateAdmission, failure: LlmFailure) {
  if (typeof rateLearning?.failRequest !== "function") return null;
  return rateLearning.failRequest({ admission, failure });
}

function rateIdentity(options: ModelOptions = {}) {
  return {
    sessionId: String(options.sessionId || "").trim(),
    runId: String(options.runId || "").trim(),
    spanId: String(options.spanId || "").trim(),
  };
}

function resolveInputTokenEstimate(messages: ModelMessage[], tools: object[], options: ModelOptions = {}) {
  const explicit = Number(options.inputTokensEstimate);
  if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
  return estimateTokens(messages) + estimateToolSchemaTokens(tools);
}

function providerRateKey(config: RuntimeConfig = {}) {
  const provider = normalizeProvider(config.provider);
  const providerDef = getProviderDef(config);
  return [
    provider,
    providerDef.protocol || providerDef.api || "",
    providerRateEndpointScope(getProviderEndpoint(providerDef)),
    providerRateCredentialScope(config.apiKey),
  ].join("|");
}

function providerRateEndpointScope(value: unknown) {
  const endpoint = String(value || "").trim();
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch (_error) {
    return endpoint.split(/[?#]/, 1)[0];
  }
}

function providerRateCredentialScope(value: unknown) {
  const credential = String(value || "").trim();
  if (!credential) return "default";
  let hash = 2166136261;
  for (let index = 0; index < credential.length; index += 1) {
    hash ^= credential.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `key-${(hash >>> 0).toString(36)}`;
}

function assertApiKey(config: RuntimeConfig) {
  if (!config.apiKey && providerRequiresApiKey(getProviderDef(config))) {
    throw new Error(t("settings.apiKeyRequired"));
  }
}


function adapterFailure(error: unknown, phase: string, adapter: ProviderAdapter, config: RuntimeConfig) {
  const failure = normalizeLlmFailure(error, { phase });
  return attachProviderRecovery(failure, adapter.recovery?.(failure, config));
}
