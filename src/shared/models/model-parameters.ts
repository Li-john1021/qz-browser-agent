import { t } from "../i18n/backend.js";
import type { JsonValue } from "../contracts/json.js";

const RESERVED_MODEL_PARAMETER_KEYS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "stream",
  "stream_options",
  "store",
  "include",
  "prompt_cache_key",
  "__proto__",
  "constructor",
  "prototype",
]);

export const MODEL_PARAMETER_SUGGESTIONS = Object.freeze([
  { key: "reasoning_effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  {
    key: "reasoning",
    values: [
      '{"effort":"medium"}',
      '{"effort":"high","summary":"auto"}',
    ],
  },
  {
    key: "thinking",
    values: [
      '{"type":"enabled"}',
      '{"type":"disabled"}',
      '{"type":"auto"}',
      '{"type":"adaptive"}',
      '{"type":"enabled","budget_tokens":4096}',
    ],
  },
  { key: "enable_thinking", values: ["true", "false"] },
  { key: "thinking_budget", values: ["1024", "4096", "8192", "16384", "32768"] },
  {
    key: "output_config",
    values: [
      '{"effort":"low"}',
      '{"effort":"medium"}',
      '{"effort":"high"}',
    ],
  },
  { key: "reasoning_format", values: ["general", "deepseek-style"] },
  { key: "reasoning_history", values: ["disabled", "interleaved", "preserved"] },
  { key: "preserved_thinking", values: ["true", "false"] },
  { key: "temperature", values: ["0", "0.2", "0.7", "1"] },
  { key: "top_p", values: ["0.8", "0.9", "0.95", "1"] },
  { key: "top_k", values: ["1", "20", "40", "50"] },
  { key: "min_p", values: ["0", "0.05", "0.1"] },
  { key: "max_tokens", values: ["4096", "8192", "16384", "32768"] },
  { key: "max_completion_tokens", values: ["4096", "8192", "16384", "32768"] },
  { key: "max_output_tokens", values: ["4096", "8192", "16384", "32768"] },
  { key: "frequency_penalty", values: ["0", "0.2", "0.5"] },
  { key: "presence_penalty", values: ["0", "0.2", "0.5"] },
  { key: "repetition_penalty", values: ["1", "1.05", "1.1"] },
  { key: "seed", values: ["0", "42"] },
  { key: "stop", values: ['["STOP"]'] },
  { key: "response_format", values: ['{"type":"json_object"}', '{"type":"text"}'] },
  { key: "parallel_tool_calls", values: ["true", "false"] },
  { key: "verbosity", values: ["low", "medium", "high"] },
]);

export const MODEL_PARAMETER_RESERVED_KEYS = Object.freeze([...RESERVED_MODEL_PARAMETER_KEYS]);

export function parseModelParameterValue(value: unknown): JsonValue {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^(?:true|false|null)$/i.test(text)) return JSON.parse(text.toLowerCase());
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error(t("model.finiteNumber"));
    return number;
  }
  if (/^[\[{\"]/.test(text)) {
    try {
      return normalizeJsonValue(JSON.parse(text));
    } catch (_err) {
      throw new Error(t("model.invalidJson"));
    }
  }
  return text;
}

export function formatModelParameterValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function parseModelParameterEntries(entries: { key?: unknown; value?: unknown }[] = []) {
  if (!Array.isArray(entries)) throw new Error(t("model.keyValueRequired"));
  const result: Record<string, JsonValue> = {};
  const seen = new Set();
  for (const entry of entries) {
    const key = normalizeModelParameterKey(entry?.key);
    const rawValue = String(entry?.value ?? "");
    if (!key && !rawValue.trim()) continue;
    if (!key) throw new Error(t("model.keyRequired"));
    assertAllowedModelParameterKey(key);
    if (seen.has(key)) throw new Error(t("model.duplicateKey", { key: String(key) }));
    seen.add(key);
    result[key] = parseModelParameterValue(rawValue);
  }
  return result;
}

export function normalizeModelParameters(value: unknown, { strict = false } = {}) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    if (strict) throw new Error(t("model.objectRequired"));
    return {};
  }
  const result: Record<string, JsonValue> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeModelParameterKey(rawKey);
    try {
      if (!key) throw new Error(t("model.keyRequired"));
      assertAllowedModelParameterKey(key);
      result[key] = normalizeJsonValue(rawValue);
    } catch (err) {
      if (strict) throw err;
    }
  }
  return result;
}

export function serializeModelParameters(value: unknown) {
  return JSON.stringify(canonicalizeJsonValue(normalizeModelParameters(value)));
}

function normalizeModelParameterKey(value: unknown) {
  return String(value ?? "").trim();
}

function assertAllowedModelParameterKey(key: string) {
  if (RESERVED_MODEL_PARAMETER_KEYS.has(key)) {
    throw new Error(t("model.reservedKey", { key: String(key) }));
  }
}

function normalizeJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(t("model.numbersFinite"));
    return value;
  }
  if (typeof value !== "object") throw new Error(t("model.jsonRequired"));
  if (seen.has(value)) throw new Error(t("model.circularValue"));
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => normalizeJsonValue(item, seen));
    if (!isPlainObject(value)) throw new Error(t("model.plainObjectRequired"));
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error(t("model.forbiddenObjectKey", { key: String(key) }));
      }
      result[key] = normalizeJsonValue(item, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map(key => [key, canonicalizeJsonValue(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
