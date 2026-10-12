import { t } from "../i18n/backend.js";
export interface SkillDiagnostic {
  level: "warning" | "error"; message: string; pluginId?: string; skillName?: string; path?: string;
}
export interface SkillDiagnosticContext { pluginId?: string; skillName?: string; toolName?: string; scope?: string }
export interface SkillSettingField {
  key: string; type: string; label: string; description: string; placeholder: string; required: boolean;
  default: string | number | boolean | null; pattern: string; min: number | null; max: number | null; step: number | null;
  width: "half" | "full"; options: { value: string; label: string }[]; reenterWhen: string[];
}
export interface SkillSettings {
  title: string; description: string; fields: SkillSettingField[];
  layout: { sections: { title: string; description: string; fields: string[] }[] };
}
export type SkillNetworkOrigin = { origin: string; setting?: never } | { setting: string; origin?: never };
export interface SkillNetworkPolicy {
  allowedOrigins: SkillNetworkOrigin[]; allowedMethods: string[]; browserManagedHeaders: string[];
  maxRequestBytes: number; maxResponseBytes: number;
}
interface InvalidSettingValue {
  ok: false; reason: string; expected?: string; maxLength?: number; min?: number; max?: number;
}
type SettingValueResult = { ok: true; value: string | boolean | number } | InvalidSettingValue;

export const SKILL_SETTING_FIELD_TYPES = new Set([
  "text",
  "secret",
  "url",
  "boolean",
  "number",
  "select",
]);

export const SKILL_NETWORK_MANAGED_HEADERS = new Set(["date"]);

const SKILL_SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_SETTING_SECTIONS = 32;
const MAX_SETTING_SECTION_TITLE = 80;
const MAX_SETTING_SECTION_DESCRIPTION = 320;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SKILL_SETTING_VALUE_MAX_LENGTH = 8192;
const MAX_SETTING_DEFAULT_LENGTH = 4096;

export function normalizeSkillSettings(value: unknown = null, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillSettings {
  const input = objectOrNull(value);
  if (!input) return emptySkillSettings();

  const fields = [];
  const seen = new Set();
  for (const rawField of Array.isArray(input.fields) ? input.fields : []) {
    const field = normalizeSkillSettingField(rawField, diagnostics, context);
    if (!field) continue;
    if (seen.has(field.key)) {
      pushDiagnostic(diagnostics, context, t("skill.duplicateSettingIgnored", { key: String(field.key) }));
      continue;
    }
    seen.add(field.key);
    fields.push(field);
  }

  for (const field of fields) {
    if (field.type !== "secret" || !field.reenterWhen.length) continue;
    const unknown = field.reenterWhen.filter(key => !seen.has(key));
    if (!unknown.length) continue;
    field.reenterWhen = field.reenterWhen.filter(key => seen.has(key));
    pushDiagnostic(diagnostics, context, t("skill.reentryFieldUnknown", { key: String(field.key), fields: String(unknown.join(", ")) }));
  }

  return {
    title: cleanString(input.title),
    description: cleanString(input.description),
    fields,
    layout: normalizeSkillSettingsLayout(input.layout, fields, diagnostics, context),
  };
}

export function normalizeSkillNetwork(value: unknown = null, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillNetworkPolicy {
  const input = objectOrNull(value);
  if (!input) return emptySkillNetworkPolicy();

  const origins = [];
  const seenOrigins = new Set();
  const rawOrigins = input.allowedOrigins ?? input.origins;
  for (const raw of Array.isArray(rawOrigins) ? rawOrigins : []) {
    const origin = normalizeSkillNetworkOrigin(raw);
    if (!origin) {
      pushDiagnostic(diagnostics, context, t("skill.invalidNetworkOrigin"));
      continue;
    }
    const identity = origin.setting ? `setting:${origin.setting}` : `origin:${origin.origin}`;
    if (seenOrigins.has(identity)) continue;
    seenOrigins.add(identity);
    origins.push(origin);
  }

  const methods = normalizeStringList(input.allowedMethods ?? input.methods)
    .map(value => value.toUpperCase())
    .filter(value => HTTP_METHODS.has(value));
  const allowedMethods = [...new Set(methods.length ? methods : ["GET"] )];

  const requestedManagedHeaders = normalizeStringList(
    input.browserManagedHeaders ?? input.managedRequestHeaders,
  ).map(value => value.toLowerCase());
  const browserManagedHeaders: string[] = [];
  for (const name of requestedManagedHeaders) {
    if (!SKILL_NETWORK_MANAGED_HEADERS.has(name)) {
      pushDiagnostic(diagnostics, context, t("skill.managedHeaderUnsupported", { name: String(name) }));
      continue;
    }
    if (!browserManagedHeaders.includes(name)) browserManagedHeaders.push(name);
  }

  return {
    allowedOrigins: origins,
    allowedMethods,
    browserManagedHeaders,
    maxRequestBytes: boundedInteger(input.maxRequestBytes, 0, 4 * 1024 * 1024, DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: boundedInteger(input.maxResponseBytes, 1024, 16 * 1024 * 1024, DEFAULT_MAX_RESPONSE_BYTES),
  };
}

export function skillSettingsIdentity(plugin: { skillName?: unknown; id?: unknown } = {}) {
  const skillName = cleanString(plugin.skillName).toLowerCase();
  const pluginId = cleanString(plugin.id).toLowerCase();
  return `${skillName}::${pluginId}`;
}

export function skillHasSettings(plugin: { settings?: { fields?: readonly unknown[] } } = {}) {
  return Array.isArray(plugin?.settings?.fields) && plugin.settings.fields.length > 0;
}

/**
 * Validate and canonicalize one value against a normalized manifest field.
 * The result shape lets manifest parsing, persistence migration and runtime
 * writes share exactly the same type and constraint rules without throwing
 * across the shared protocol boundary.
 */
export function normalizeSkillSettingValue(value: unknown, field: Partial<SkillSettingField> = {}, options: { maxLength?: number } = {}): SettingValueResult {
  const type = cleanString(field.type || "text").toLowerCase();
  const maxLength = typeof options.maxLength === "number" && Number.isInteger(options.maxLength) && options.maxLength > 0
    ? options.maxLength
    : SKILL_SETTING_VALUE_MAX_LENGTH;

  if (type === "boolean") {
    return typeof value === "boolean"
      ? validSettingValue(value)
      : invalidSettingValue("type", { expected: "boolean" });
  }

  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalidSettingValue("type", { expected: "number" });
    }
    if (field.min != null && value < field.min) {
      return invalidSettingValue("number_min", { min: field.min });
    }
    if (field.max != null && value > field.max) {
      return invalidSettingValue("number_max", { max: field.max });
    }
    return validSettingValue(value);
  }

  if (!SKILL_SETTING_FIELD_TYPES.has(type) || typeof value !== "string") {
    return invalidSettingValue("type", { expected: "string" });
  }

  const text = type === "secret" ? value : value.trim();
  if (text.length > maxLength) {
    return invalidSettingValue("too_long", { maxLength });
  }

  if (type === "url" && text) {
    let url;
    try {
      url = new URL(text);
    } catch (_err) {
      return invalidSettingValue("url");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      return invalidSettingValue("url");
    }
    url.hash = "";
    return validSettingValue(url.href.replace(/\/$/, ""));
  }

  if (type === "select" && text) {
    const options = Array.isArray(field.options) ? field.options : [];
    if (!options.some(option => option?.value === text)) {
      return invalidSettingValue("select");
    }
  }

  if (type === "text" && field.pattern && text) {
    let pattern;
    try {
      pattern = new RegExp(field.pattern);
    } catch (_err) {
      return invalidSettingValue("pattern_invalid");
    }
    if (!pattern.test(text)) return invalidSettingValue("pattern");
  }

  return validSettingValue(text);
}

export function emptySkillNetworkPolicy(): SkillNetworkPolicy {
  return {
    allowedOrigins: [],
    allowedMethods: ["GET"],
    browserManagedHeaders: [],
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
}

function emptySkillSettings(): SkillSettings {
  return { title: "", description: "", fields: [], layout: { sections: [] } };
}

function normalizeSkillSettingsLayout(value: unknown, fields: SkillSettingField[], diagnostics: SkillDiagnostic[], context: SkillDiagnosticContext): SkillSettings["layout"] {
  const input = objectOrNull(value);
  if (!input) return { sections: [] };
  if (input.sections != null && !Array.isArray(input.sections)) {
    pushDiagnostic(diagnostics, context, t("skill.sectionsArray"));
    return { sections: [] };
  }

  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  if (rawSections.length > MAX_SETTING_SECTIONS) {
    pushDiagnostic(diagnostics, context, t("skill.sectionLimit", { maximum: String(MAX_SETTING_SECTIONS) }));
  }
  const knownFields = new Set(fields.map(field => field.key));
  const claimedFields = new Set();
  const sections = [];

  for (const rawSection of rawSections.slice(0, MAX_SETTING_SECTIONS)) {
    const section = objectOrNull(rawSection);
    if (!section) {
      pushDiagnostic(diagnostics, context, t("skill.sectionObject"));
      continue;
    }
    const title = cleanString(section.title).slice(0, MAX_SETTING_SECTION_TITLE);
    if (!title) {
      pushDiagnostic(diagnostics, context, t("skill.sectionTitle"));
      continue;
    }
    if (!Array.isArray(section.fields)) {
      pushDiagnostic(diagnostics, context, t("skill.sectionFieldsArray", { title: String(title) }));
      continue;
    }

    const sectionFields = [];
    const localFields = new Set();
    for (const rawKey of section.fields) {
      const key = cleanString(rawKey);
      if (!knownFields.has(key)) {
        pushDiagnostic(diagnostics, context, t("skill.sectionUnknownField", { title: String(title), key: String(key || "(empty)") }));
        continue;
      }
      if (localFields.has(key) || claimedFields.has(key)) {
        pushDiagnostic(diagnostics, context, t("skill.sectionDuplicateField", { key: String(key) }));
        continue;
      }
      localFields.add(key);
      claimedFields.add(key);
      sectionFields.push(key);
    }
    if (!sectionFields.length) {
      pushDiagnostic(diagnostics, context, t("skill.sectionEmpty", { title: String(title) }));
      continue;
    }
    sections.push({
      title,
      description: cleanString(section.description || section.help).slice(0, MAX_SETTING_SECTION_DESCRIPTION),
      fields: sectionFields,
    });
  }
  return { sections };
}

function normalizeSkillSettingField(value: unknown, diagnostics: SkillDiagnostic[], context: SkillDiagnosticContext): SkillSettingField | null {
  const input = objectOrNull(value);
  if (!input) return null;
  const key = cleanString(input.key || input.name);
  if (!SKILL_SETTING_KEY_RE.test(key)) {
    pushDiagnostic(diagnostics, context, t("skill.fieldInvalidKey", { key: String(key || "(empty)") }));
    return null;
  }
  const type = cleanString(input.type || "text").toLowerCase();
  if (!SKILL_SETTING_FIELD_TYPES.has(type)) {
    pushDiagnostic(diagnostics, context, t("skill.fieldInvalidType", { key: String(key), type: String(type) }));
    return null;
  }
  const options = type === "select" ? normalizeSelectOptions(input.options) : [];
  if (type === "select" && !options.length) {
    pushDiagnostic(diagnostics, context, t("skill.selectNoOptions", { key: String(key) }));
    return null;
  }
  let pattern = type === "text" ? cleanString(input.pattern).slice(0, 256) : "";
  if (pattern) {
    try {
      new RegExp(pattern);
    } catch (_err) {
      pushDiagnostic(diagnostics, context, t("skill.fieldInvalidPattern", { key: String(key) }));
    }
  }
  const field: SkillSettingField = {
    key,
    type,
    label: cleanString(input.label || input.title || key),
    description: cleanString(input.description || input.help),
    placeholder: cleanString(input.placeholder),
    required: input.required === true,
    default: null,
    pattern,
    min: type === "number" ? finiteNumberOrNull(input.min) : null,
    max: type === "number" ? finiteNumberOrNull(input.max) : null,
    step: type === "number" ? positiveNumberOrNull(input.step) : null,
    width: cleanString(input.width).toLowerCase() === "half" ? "half" : "full",
    options,
    reenterWhen: type === "secret"
      ? normalizeStringList(input.reenterWhen).filter(key => SKILL_SETTING_KEY_RE.test(key))
      : [],
  };
  field.default = normalizeSettingDefault(input.default, field, diagnostics, context);
  return field;
}

function normalizeSelectOptions(value: unknown) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const option = typeof item === "string"
      ? { value: item, label: item }
      : objectOrNull(item);
    const optionValue = cleanString(option?.value);
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    out.push({ value: optionValue, label: cleanString(option?.label || optionValue) });
  }
  return out;
}

function normalizeSettingDefault(value: unknown, field: SkillSettingField, diagnostics: SkillDiagnostic[], context: SkillDiagnosticContext) {
  const fallback = defaultSettingValue(field.type);
  if (value === undefined || value === null) {
    return fallback;
  }
  if (field.type === "secret") {
    if (value !== "") {
      pushDiagnostic(diagnostics, context, t("skill.secretDefaultIgnored", { key: String(field.key) }));
    }
    return "";
  }
  const normalized = normalizeSkillSettingValue(value, field, {
    maxLength: MAX_SETTING_DEFAULT_LENGTH,
  });
  if (normalized.ok) return normalized.value;
  pushDiagnostic(
    diagnostics,
    context,
    t("skill.invalidDefault", { key: String(field.key), reason: String(settingValueDiagnosticReason(normalized)) }),
  );
  return fallback;
}

function defaultSettingValue(type: string) {
  if (type === "boolean") return false;
  if (type === "number") return null;
  return "";
}

function validSettingValue(value: string | number | boolean): SettingValueResult {
  return { ok: true, value };
}

function invalidSettingValue(reason: string, details: Omit<InvalidSettingValue, "ok" | "reason"> = {}): InvalidSettingValue {
  return { ok: false, reason, ...details };
}

function settingValueDiagnosticReason(result: InvalidSettingValue) {
  if (result.reason === "type") return t("skill.expectedType", { type: String(result.expected) });
  if (result.reason === "too_long") return t("skill.exceedsLength", { maxLength: String(result.maxLength) });
  if (result.reason === "number_min") return t("skill.belowMinimum", { min: String(result.min) });
  if (result.reason === "number_max") return t("skill.aboveMaximum", { max: String(result.max) });
  if (result.reason === "url") return t("skill.invalidHttp");
  if (result.reason === "select") return t("skill.notOption");
  if (result.reason === "pattern_invalid") return t("skill.invalidPattern");
  if (result.reason === "pattern") return t("skill.patternMismatch");
  return t("skill.invalidValue");
}

function normalizeSkillNetworkOrigin(value: unknown): SkillNetworkOrigin | null {
  if (typeof value === "string") {
    const text = cleanString(value);
    if (text.startsWith("setting:")) {
      const setting = cleanString(text.slice("setting:".length));
      return SKILL_SETTING_KEY_RE.test(setting) ? { setting } : null;
    }
    return normalizeStaticOrigin(text);
  }
  const input = objectOrNull(value);
  if (!input) return null;
  const setting = cleanString(input.setting || input.settingKey);
  if (setting) return SKILL_SETTING_KEY_RE.test(setting) ? { setting } : null;
  return normalizeStaticOrigin(input.origin || input.url);
}

function normalizeStaticOrigin(value: unknown): SkillNetworkOrigin | null {
  try {
    const url = new URL(cleanString(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return { origin: url.origin };
  } catch (_err) {
    return null;
  }
}

function normalizeStringList(value: unknown) {
  const rows = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return rows.map(cleanString).filter(Boolean);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function finiteNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumberOrNull(value: unknown) {
  const number = finiteNumberOrNull(value);
  return number != null && number > 0 ? number : null;
}

function pushDiagnostic(diagnostics: SkillDiagnostic[], context: SkillDiagnosticContext, message: string) {
  diagnostics.push({
    level: "warning",
    ...(context.pluginId ? { pluginId: context.pluginId } : {}),
    ...(context.skillName ? { skillName: context.skillName } : {}),
    message,
  });
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanString(value: unknown = "") {
  return String(value ?? "").trim();
}
