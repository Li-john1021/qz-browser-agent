import { getLanguage } from "../../shared/i18n/index.js";
import { t } from "../../shared/i18n/backend.js";
import type { StorageAdapter } from "../internal/storage.js";
import type { SkillManifest } from "../../shared/skills/skill-manifest.js";
import type { SkillSettingField, SkillSettings } from "../../shared/skills/skill-settings.js";
type Fields = Record<string, unknown>;
type SettingValues = Record<string, string | boolean | number>;
type SettingsSkillManifest = Pick<SkillManifest, "id" | "skillName" | "displayName" | "name" | "skillDisplayName" | "description" | "settings">;
type SkillManifestList = readonly SettingsSkillManifest[] | { plugins: readonly SettingsSkillManifest[] };
interface SkillSettingsOptions {
  storage?: StorageAdapter;
  listSkillManifests?: () => SkillManifestList | Promise<SkillManifestList>;
  now?: () => string;
}
interface SettingsState { version: number; records: Fields }
interface SettingsRecord { pluginId: string; skillName: string; values: Fields; updatedAt: string }
type PublicSettings = ReturnType<typeof settingsForSidePanel>;
import {
  skillHasSettings,
  skillSettingsIdentity,
  normalizeSkillSettingValue,
} from "../../shared/skills/skill-settings.js";

export const SKILL_SETTINGS_STORAGE_KEY = "_qz_skill_settings_v1";

const STORAGE_VERSION = 1;

export class SkillSettingsError extends Error {
  code: string;
  details: Fields;
  constructor(code: string, message: string, details: Fields = {}) {
    super(message);
    this.name = "SkillSettingsError";
    this.code = code;
    this.details = details;
  }
}

export function createSkillSettingsService(options: SkillSettingsOptions = {}) {
  const storage = options.storage || globalThis.chrome?.storage?.local;
  const listSkillManifests = typeof options.listSkillManifests === "function" ? options.listSkillManifests : async () => [];
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  if (!storage?.get || !storage?.set || !storage?.remove) {
    throw new TypeError("Skill settings service requires chrome.storage.local-compatible storage");
  }
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function list() {
    const [plugins, state] = await Promise.all([resolveSkillManifests(listSkillManifests), readState(storage)]);
    return {
      settings: plugins
        .filter(skillHasSettings)
        .map(plugin => settingsForSidePanel(plugin, state.records[skillSettingsIdentity(plugin)]))
        .sort(comparePublicSettings),
    };
  }

  async function save(input: Fields = {}) {
    return enqueueWrite(async () => {
      const plugin = await requireSkillManifest(listSkillManifests, input);
      const state = await readState(storage);
      const identity = skillSettingsIdentity(plugin);
      const previous = recordForSkill(plugin, state.records[identity]);
      const values = objectOrEmpty(input.values);
      const clearSecrets = new Set(normalizeStringList(input.clearSecrets));
      assertKnownInputKeys(plugin, values, clearSecrets);

      const nextValues = { ...previous.values };
      for (const field of plugin.settings.fields) {
        if (field.type === "secret") {
          if (clearSecrets.has(field.key)) {
            delete nextValues[field.key];
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(values, field.key)) {
            const value = values[field.key];
            if (value === "") delete nextValues[field.key];
            else nextValues[field.key] = normalizeSubmittedFieldValue(value, field);
          }
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(values, field.key)) {
          if (field.type === "number" && (values[field.key] === "" || values[field.key] == null)) {
            delete nextValues[field.key];
            continue;
          }
          nextValues[field.key] = normalizeSubmittedFieldValue(values[field.key], field);
        }
      }

      const previousEffectiveValues = effectiveValues(plugin, previous.values);
      const nextEffectiveValues = effectiveValues(plugin, nextValues);
      assertSecretReentry(plugin, previousEffectiveValues, nextEffectiveValues, values, clearSecrets);
      assertRequiredSettings(plugin, nextEffectiveValues);
      const updatedAt = now();
      state.records[identity] = {
        pluginId: plugin.id,
        skillName: plugin.skillName,
        values: nextValues,
        updatedAt,
      };
      await writeState(storage, state);
      return { setting: settingsForSidePanel(plugin, state.records[identity]) };
    });
  }

  async function remove(input: Fields = {}) {
    return enqueueWrite(async () => {
      const plugin = await requireSkillManifest(listSkillManifests, input);
      const state = await readState(storage);
      const identity = skillSettingsIdentity(plugin);
      delete state.records[identity];
      await persistState(storage, state);
      return { setting: settingsForSidePanel(plugin, null) };
    });
  }

  /**
   * Reconcile the prepared candidate before registry commit. Failure keeps the last
   * committed registry visible; settings reads must not await this transaction's readiness.
   */
  async function reconcile(input: Fields & { plugins?: SkillManifestList } = {}) {
    return enqueueWrite(async () => {
      const plugins = skillList(input.plugins).filter(skillHasSettings);
      const activeByIdentity = new Map(plugins.map(plugin => [skillSettingsIdentity(plugin), plugin]));
      const state = await readState(storage);
      const renames = normalizeSkillRenames(input);
      let changed = false;
      let migrated = 0;
      let removed = 0;
      let prunedValues = 0;

      for (const rename of renames) {
        for (const [identity, rawRecord] of Object.entries({ ...state.records })) {
          const record = normalizeRecord(rawRecord);
          if (record.skillName.toLowerCase() !== rename.from.toLowerCase()) continue;
          const nextSkill = plugins.find(plugin => (
            String(plugin.skillName || "").toLowerCase() === rename.to.toLowerCase()
            && String(plugin.id || "").toLowerCase() === record.pluginId.toLowerCase()
          ));
          if (!nextSkill) continue;
          const nextIdentity = skillSettingsIdentity(nextSkill);
          if (!state.records[nextIdentity]) {
            state.records[nextIdentity] = recordForSkill(nextSkill, record);
            migrated += 1;
          }
          if (identity !== nextIdentity) {
            delete state.records[identity];
            changed = true;
          }
        }
      }

      for (const [identity, rawRecord] of Object.entries({ ...state.records })) {
        const plugin = activeByIdentity.get(identity);
        if (!plugin) {
          delete state.records[identity];
          removed += 1;
          changed = true;
          continue;
        }
        const previous = normalizeRecord(rawRecord);
        const next = recordForSkill(plugin, previous);
        prunedValues += Math.max(0, Object.keys(previous.values).length - Object.keys(next.values).length);
        if (!recordsEqual(previous, next)) {
          state.records[identity] = next;
          changed = true;
        }
      }

      if (changed) await persistState(storage, state);
      return {
        changed,
        migrated,
        removed,
        prunedValues,
        records: Object.keys(state.records).length,
      };
    });
  }

  async function getExecutionConfig(plugin: Partial<SettingsSkillManifest> = {}, runtimeOptions: { includeSecrets?: boolean } = {}) {
    if (!plugin.settings || !skillHasSettings(plugin)) return {};
    const configuredSkill = { ...plugin, settings: plugin.settings };
    const state = await readState(storage);
    const record = normalizeRecord(state.records[skillSettingsIdentity(plugin)]);
    const values = effectiveValues(configuredSkill, record.values);
    assertRequiredSettings(configuredSkill, values, { execution: true });
    const includeSecrets = runtimeOptions.includeSecrets === true;
    const config: SettingValues = {};
    for (const field of plugin.settings.fields) {
      if (field.type === "secret" && !includeSecrets) continue;
      if (Object.prototype.hasOwnProperty.call(values, field.key)) config[field.key] = values[field.key];
    }
    return config;
  }

  function enqueueWrite<T>(operation: () => Promise<T>) {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.catch(() => {});
    return run;
  }

  return Object.freeze({ list, save, remove, reconcile, getExecutionConfig });
}

function settingsForSidePanel(plugin: SettingsSkillManifest, rawRecord: unknown) {
  const record = normalizeRecord(rawRecord);
  const values = effectiveValues(plugin, record.values);
  const missing = requiredMissingFields(plugin, values);
  return {
    id: skillSettingsIdentity(plugin),
    pluginId: plugin.id,
    pluginName: plugin.displayName || plugin.name || plugin.id,
    skillName: plugin.skillName,
    skillDisplayName: plugin.skillDisplayName || plugin.skillName,
    title: plugin.settings.title || plugin.displayName || plugin.name || plugin.id,
    description: plugin.settings.description || plugin.description || "",
    configured: missing.length === 0 && Boolean(rawRecord),
    missing,
    updatedAt: record.updatedAt,
    layout: settingsLayoutForSidePanel(plugin.settings.layout),
    fields: plugin.settings.fields.map(field => ({
      ...field,
      value: field.type === "secret" ? (values[field.key] ?? "") : values[field.key],
      hasValue: field.type === "secret" && hasSettingValue(record.values[field.key], field),
    })),
  };
}

function settingsLayoutForSidePanel(layout: SkillSettings["layout"]) {
  return {
    sections: (Array.isArray(layout?.sections) ? layout.sections : []).map(section => ({
      title: String(section.title || ""),
      description: String(section.description || ""),
      fields: (Array.isArray(section.fields) ? section.fields : []).map(String),
    })),
  };
}

function effectiveValues(plugin: { settings: SkillSettings }, storedValues: Fields = {}) {
  const values: SettingValues = {};
  for (const field of plugin.settings.fields || []) {
    const stored = normalizedPresentSettingValue(storedValues[field.key], field);
    if (stored) values[field.key] = stored.value;
    else if (field.type !== "secret") {
      const fallback = normalizedPresentSettingValue(field.default, field);
      if (fallback) values[field.key] = fallback.value;
    }
  }
  return values;
}

function assertSecretReentry(plugin: SettingsSkillManifest, previousValues: Fields, nextValues: Fields, submittedValues: Fields, clearSecrets: Set<string>) {
  for (const field of plugin.settings.fields || []) {
    if (field.type !== "secret" || !field.reenterWhen?.length) continue;
    const dependencyChanged = field.reenterWhen.some(key => !settingValuesEqual(previousValues[key], nextValues[key]));
    if (!dependencyChanged) continue;
    if (!field.required && !hasSettingValue(previousValues[field.key], field)) continue;
    const submitted = Object.prototype.hasOwnProperty.call(submittedValues, field.key)
      && String(submittedValues[field.key] ?? "").length > 0;
    if (submitted && !clearSecrets.has(field.key)) continue;
    throw new SkillSettingsError(
      "SKILL_SETTING_SECRET_REENTRY_REQUIRED",
      t("skill.secretReentry", { label: String(field.label || field.key) }),
      { pluginId: plugin.id, skillName: plugin.skillName, field: field.key, dependencies: field.reenterWhen },
    );
  }
}

function assertRequiredSettings(plugin: Partial<SettingsSkillManifest> & { settings: SkillSettings }, values: Fields, options: { execution?: boolean } = {}) {
  const missing = requiredMissingFields(plugin, values);
  if (!missing.length) return;
  const fields = plugin.settings.fields.filter(field => missing.includes(field.key));
  throw new SkillSettingsError(
    options.execution ? "SKILL_SETTINGS_REQUIRED" : "SKILL_SETTINGS_INVALID",
    t("skill.setupRequired", { name: String(plugin.settings.title || plugin.displayName || plugin.name), fields: String(fields.map(field => field.label || field.key).join(getLanguage() === "zh-CN" ? "、" : ", ")) }),
    { pluginId: plugin.id, skillName: plugin.skillName, missing },
  );
}

function requiredMissingFields(plugin: { settings: SkillSettings }, values: Fields) {
  return (plugin.settings.fields || [])
    .filter(field => field.required && !hasSettingValue(values[field.key], field))
    .map(field => field.key);
}

function hasSettingValue(value: unknown, field: SkillSettingField) {
  return Boolean(normalizedPresentSettingValue(value, field));
}

function normalizedPresentSettingValue(value: unknown, field: SkillSettingField) {
  const normalized = normalizeSkillSettingValue(value, field);
  if (!normalized.ok) return null;
  if (field.type !== "boolean" && field.type !== "number" && typeof normalized.value === "string" && normalized.value.length === 0) return null;
  return normalized;
}

function normalizeSubmittedFieldValue(value: unknown, field: SkillSettingField) {
  const normalized = normalizeSkillSettingValue(value, field);
  if (normalized.ok) return normalized.value;
  const label = field.label || field.key;
  if (normalized.reason === "type") {
    const expected = normalized.expected === "boolean" ? t("toolFailure.booleanType") : (normalized.expected === "number" ? t("toolFailure.numberType") : t("toolFailure.textType"));
    throw invalidField(field, t("skill.settingType", { label: String(label), expected: String(expected) }));
  }
  if (normalized.reason === "too_long") throw invalidField(field, t("skill.settingTooLong", { label: String(label) }));
  if (normalized.reason === "number_min") throw invalidField(field, t("skill.settingMinimum", { label: String(label), min: String(normalized.min) }));
  if (normalized.reason === "number_max") throw invalidField(field, t("skill.settingMaximum", { label: String(label), max: String(normalized.max) }));
  if (normalized.reason === "url") throw invalidField(field, t("skill.settingHttp", { label: String(label) }));
  if (normalized.reason === "select") throw invalidField(field, t("skill.settingOption", { label: String(label) }));
  if (normalized.reason === "pattern_invalid") throw invalidField(field, t("skill.settingRule", { label: String(label) }));
  if (normalized.reason === "pattern") throw invalidField(field, t("skill.settingFormat", { label: String(label) }));
  throw invalidField(field, t("skill.settingValue", { label: String(label) }));
}

function invalidField(field: SkillSettingField, message: string) {
  return new SkillSettingsError("SKILL_SETTING_VALUE_INVALID", message, { field: field.key });
}

function assertKnownInputKeys(plugin: SettingsSkillManifest, values: Fields, clearSecrets: Set<string>) {
  const fields = new Map((plugin.settings.fields || []).map(field => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!fields.has(key)) throw new SkillSettingsError("SKILL_SETTING_UNKNOWN", t("skill.settingUnknown", { key: String(key) }), { field: key });
  }
  for (const key of clearSecrets) {
    if (fields.get(key)?.type !== "secret") {
      throw new SkillSettingsError("SKILL_SETTING_UNKNOWN", t("skill.clearNonSecret", { key: String(key) }), { field: key });
    }
  }
}

async function requireSkillManifest(listSkillManifests: NonNullable<SkillSettingsOptions["listSkillManifests"]>, input: Fields) {
  const pluginId = String(input.pluginId || "").trim();
  const skillName = String(input.skillName || "").trim();
  const plugins = await resolveSkillManifests(listSkillManifests);
  const plugin = plugins.find(item => (
    item.id === pluginId
    && (!skillName || String(item.skillName || "").toLowerCase() === skillName.toLowerCase())
  ));
  if (!plugin || !skillHasSettings(plugin)) {
    throw new SkillSettingsError("SKILL_SETTINGS_NOT_FOUND", t("skill.settingsMissing"), { pluginId, skillName });
  }
  return plugin;
}

async function resolveSkillManifests(listSkillManifests: NonNullable<SkillSettingsOptions["listSkillManifests"]>) {
  return skillList(await listSkillManifests());
}

async function readState(storage: StorageAdapter): Promise<SettingsState> {
  const stored = await storage.get(SKILL_SETTINGS_STORAGE_KEY);
  const raw = objectOrEmpty(stored?.[SKILL_SETTINGS_STORAGE_KEY]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: STORAGE_VERSION, records: {} };
  const records = objectOrEmpty(raw.records);
  return { version: STORAGE_VERSION, records: { ...records } };
}

async function writeState(storage: StorageAdapter, state: SettingsState) {
  await storage.set({
    [SKILL_SETTINGS_STORAGE_KEY]: {
      version: STORAGE_VERSION,
      records: state.records,
    },
  });
}

async function persistState(storage: StorageAdapter, state: SettingsState) {
  if (Object.keys(state.records).length) await writeState(storage, state);
  else await storage.remove(SKILL_SETTINGS_STORAGE_KEY);
}

function normalizeRecord(value: unknown): SettingsRecord {
  const input = objectOrEmpty(value);
  return {
    pluginId: String(input.pluginId || ""),
    skillName: String(input.skillName || ""),
    values: objectOrEmpty(input.values),
    updatedAt: String(input.updatedAt || ""),
  };
}

function recordForSkill(plugin: SettingsSkillManifest, rawRecord: unknown): SettingsRecord {
  const record = normalizeRecord(rawRecord);
  const values: SettingValues = {};
  for (const field of plugin.settings?.fields || []) {
    if (!Object.prototype.hasOwnProperty.call(record.values, field.key)) continue;
    const normalized = normalizedPresentSettingValue(record.values[field.key], field);
    if (normalized) values[field.key] = normalized.value;
  }
  return {
    pluginId: String(plugin.id || ""),
    skillName: String(plugin.skillName || ""),
    values,
    updatedAt: record.updatedAt,
  };
}

function recordsEqual(left: SettingsRecord, right: SettingsRecord) {
  return left.pluginId === right.pluginId
    && left.skillName === right.skillName
    && left.updatedAt === right.updatedAt
    && JSON.stringify(left.values) === JSON.stringify(right.values);
}

function skillList(value: SkillManifestList | undefined): readonly SettingsSkillManifest[] {
  return value && "plugins" in value ? value.plugins : value || [];
}

function normalizeSkillRenames(input: Fields = {}) {
  const values = [
    ...(Array.isArray(input.renames) ? input.renames : []),
    {
      from: input.previousSkillName,
      to: input.skillName,
    },
  ];
  const seen = new Set();
  const out = [];
  for (const rawValue of values) {
    const value = objectOrEmpty(rawValue);
    const from = String(value?.from || value?.previousSkillName || "").trim();
    const to = String(value?.to || value?.skillName || "").trim();
    const identity = `${from.toLowerCase()}::${to.toLowerCase()}`;
    if (!from || !to || from.toLowerCase() === to.toLowerCase() || seen.has(identity)) continue;
    seen.add(identity);
    out.push({ from, to });
  }
  return out;
}

function comparePublicSettings(left: PublicSettings, right: PublicSettings) {
  return String(left.title || left.pluginName).localeCompare(String(right.title || right.pluginName), "zh-CN");
}

function settingValuesEqual(left: unknown, right: unknown) {
  return left === right || String(left ?? "") === String(right ?? "");
}

function objectOrEmpty(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value as Fields } : {};
}

function normalizeStringList(value: unknown) {
  return (Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean);
}
