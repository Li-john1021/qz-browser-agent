import { skillMetaFromResult } from "../skill-renderer-context.js";
import { record } from "../renderer-input.js";
type Data = Record<string, unknown>;

/** Normalize historical Skill/MCP result envelopes without loading a capability package. */
export function skillResultData(result: unknown, originalResult: unknown, plugin: Data | null = null) {
  const candidate = result != null && result !== "" ? result : record(originalResult).result;
  const value = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (record(candidate)._plugin && record(candidate).result && typeof record(candidate).result === "object" ? record(candidate).result : candidate)
    : candidate;
  const data = stripSkillMeta(unwrapSkillResultData(value));
  const meta = skillMetaFromResult(result, originalResult);
  return (meta?.runtime || plugin?.runtime) === "mcp" ? normalizeMcpRendererData(data) : data;
}

function unwrapSkillResultData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  if (!hasResult) return value;
  const keys = Object.keys(value);
  const isToolEnvelope = keys.length === 1 || ["ok", "hasResult", "resultType", "engine", "reason", "error", "code"]
    .some(key => Object.prototype.hasOwnProperty.call(value, key));
  return isToolEnvelope ? record(value).result : value;
}

export function stripSkillMeta(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value;
  const out = { ...record(value) };
  delete out._plugin;
  return out;
}

export function normalizeMcpRendererData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = record(value);
  const text = mcpTextFromResult(data);
  const structured = data.structuredContent !== undefined
    ? data.structuredContent
    : parseMcpJsonText(text);
  if (structured !== undefined) {
    return mergeMcpStructuredData(structured, data, text);
  }
  return text ? { ...value, text } : value;
}

function mergeMcpStructuredData(structured: unknown, value: Data = {}, text = "") {
  const base = {
    ...(text ? { text } : {}),
    ...(Array.isArray(value.content) ? { content: value.content } : {}),
    ...(value.raw !== undefined ? { raw: value.raw } : {}),
  };
  if (Array.isArray(structured)) {
    return {
      ...base,
      items: structured,
      rows: structured,
      records: structured,
      structuredContent: structured,
    };
  }
  if (structured && typeof structured === "object") {
    return {
      ...base,
      ...structured,
      structuredContent: structured,
    };
  }
  return {
    ...base,
    value: structured,
    structuredContent: structured,
  };
}

function mcpTextFromResult(value: Data = {}) {
  if (typeof value?.text === "string" && value.text.trim()) return value.text;
  const content = Array.isArray(value?.content) ? value.content.map(record) : [];
  return content
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .filter(Boolean)
    .join("\n");
}

function parseMcpJsonText(text = ""): unknown {
  const raw = String(text || "").trim();
  if (!raw || !/^[\[{]/.test(raw)) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return undefined;
  }
}
