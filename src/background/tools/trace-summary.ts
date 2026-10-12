interface Limits { string: number; head: number; nested: number; nestedHead: number; total: number }
const core: Limits = { string: 140, head: 90, nested: 90, nestedHead: 65, total: 1200 };
const plugin: Limits = { string: 120, head: 80, nested: 80, nestedHead: 60, total: 900 };

/** Bounded diagnostic summaries omit Skill configuration and never stringify full nested payloads. */
function summarize(value: unknown, limits: Limits): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value).slice(0, 180);
  const input = Array.isArray(value) ? { items: value } : value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "$plugin") continue;
    if (typeof raw === "string") out[key] = trim(raw, limits.string, limits.head);
    else if (Array.isArray(raw)) out[key] = { type: "array", length: raw.length, sample: raw.slice(0, 3).map(item => scalar(item, limits)) };
    else out[key] = scalar(raw, limits);
  }
  try { return JSON.stringify(out).slice(0, limits.total); }
  catch { return "[unserializable]"; }
}

function trim(value: string, limit: number, head: number): string {
  return value.length > limit ? `${value.slice(0, head)}…(${value.length} chars)` : value;
}

function scalar(value: unknown, limits: Limits): unknown {
  if (value == null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 8)) {
    if (typeof raw === "string") out[key] = trim(raw, limits.nested, limits.nestedHead);
    else if (Array.isArray(raw)) out[key] = `[array:${raw.length}]`;
    else if (raw && typeof raw === "object") out[key] = `{${Object.keys(raw).slice(0, 6).join(",")}}`;
    else out[key] = raw;
  }
  return out;
}

export const summarizeToolArgsForTrace = (value: unknown): string => summarize(value, core);
export const summarizeSkillArgsForTrace = (value: unknown): string => summarize(value, plugin);
