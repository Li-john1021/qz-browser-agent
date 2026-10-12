import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { ProviderDefinition } from './provider-types.js';

import { getProviderEndpoint } from "./provider-endpoint.js";

export const PROVIDER_STATE_OPENAI_REASONING = "openai_reasoning";
export const PROVIDER_STATE_ANTHROPIC_THINKING = "anthropic_thinking";
export const PROVIDER_STATE_OPENAI_RESPONSES_REASONING = "openai_responses_reasoning";

const PROVIDER_STATE_VERSION = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const MAX_OUTPUT_TOKENS_HARD_CAP = 128000;
const OUTPUT_TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

export function createAssistantProviderState(config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}, state: Record<string, unknown> = {}) {
  const provider = String(config.provider || "").trim().toLowerCase();
  return {
    version: PROVIDER_STATE_VERSION,
    provider,
    api: String(providerDef.api || ""),
    protocol: String(providerDef.protocol || ""),
    endpoint: getProviderEndpoint(providerDef),
    model: String(config.model || ""),
    ...state,
  };
}

export function isReplayableProviderState(value: unknown, config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (Number(state.version || 0) !== PROVIDER_STATE_VERSION) return false;
  if (String(state.provider || "") !== String(config.provider || "").trim().toLowerCase()) return false;
  if (String(state.model || "") !== String(config.model || "")) return false;
  if (String(state.api || "") && String(state.api || "") !== String(providerDef.api || "")) return false;
  if (String(state.protocol || "") && String(state.protocol || "") !== String(providerDef.protocol || "")) return false;
  const endpoint = String(state.endpoint || "");
  return !endpoint || endpoint === getProviderEndpoint(providerDef);
}

/** Alternate tool-call spellings share one ingress boundary; streaming keeps whitespace fragments. */
export function normalizeToolCallName(input: unknown = {}) {
  const tool = toolCallRecord(input), fn = toolCallRecord(tool.function);
  return String(fn.name || tool.name || tool.tool_name || tool.function_name || "").trim();
}

export function getToolCallArgumentsValue(input: unknown = {}, { allowWhitespaceOnly = false } = {}) {
  const tool = toolCallRecord(input), fn = toolCallRecord(tool.function);
  for (const value of [fn.arguments, fn.arguments_json, fn.input, fn.parameters,
    tool.arguments, tool.arguments_json, tool.input, tool.parameters, tool.args]) {
    if (value == null || value === "") continue;
    if (typeof value === "string" && !allowWhitespaceOnly && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function toolCallRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseToolArguments(value: unknown): unknown {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_err) {
    return {};
  }
}

export function contentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[]).map(value => {
    const part = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (part?.type === "text") return String(part.text || "");
    if (part?.type === "image_url") return "[Image]";
    return String(part?.text || part?.content || "");
  }).filter(Boolean).join("\n");
}

export function normalizeJsonArgumentString(value: unknown): string {
  const raw = String(value || "");
  try {
    return JSON.stringify(JSON.parse(raw || "{}"));
  } catch (_err) {
    return raw || "{}";
  }
}

export function resolveRequestMaxOutputTokens(options: { maxTokens?: unknown; maxOutputTokens?: unknown } = {}): number {
  const raw = options.maxTokens ?? options.maxOutputTokens;
  const configured = Number(raw);
  const value = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(1024, Math.min(MAX_OUTPUT_TOKENS_HARD_CAP, Math.floor(value)));
}

export function isOutputTruncatedFinishReason(reason = "") {
  return OUTPUT_TRUNCATED_FINISH_REASONS.has(String(reason || "").trim());
}

export function formatOutputTruncatedError(reason = "") {
  return `LLM output was truncated by finish_reason=${reason}. The partial tool call was discarded; retry with smaller tool arguments or write bulk data inside run_script.`;
}

export function normalizeHeaderToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

