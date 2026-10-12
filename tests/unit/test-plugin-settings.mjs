import assert from "node:assert/strict";
import {
  normalizeSkillManifest,
} from "../../src/shared/skills/skill-manifest.js";
import {
  normalizeSkillSettings,
  normalizeSkillSettingValue,
} from "../../src/shared/skills/skill-settings.js";
import {
  createSkillSettingsService,
  SKILL_SETTINGS_STORAGE_KEY,
} from "../../src/background/skills/skill-settings.js";

const diagnostics = [];
const plugin = normalizeSkillManifest({
  format: "qingzhou.plugin",
  schemaVersion: 1,
  id: "settings-example",
  displayName: "设置示例",
  settings: {
    title: "示例服务",
    fields: [
      { key: "endpoint", type: "url", label: "Endpoint", required: true },
      { key: "accessId", type: "text", label: "Access ID", required: true },
      { key: "secret", type: "secret", label: "Secret", required: true, reenterWhen: ["endpoint", "accessId"] },
      { key: "token", type: "secret", label: "Token", reenterWhen: ["endpoint"] },
      { key: "retries", type: "number", label: "Retries", min: 0, max: 5 },
      { key: "mode", type: "select", label: "Mode", default: "safe", options: ["safe", "fast"] },
      { key: "allowWrites", type: "boolean", label: "Writes", default: false },
    ],
    layout: {
      sections: [
        { title: "Connection", description: "Where requests run", fields: ["endpoint", "accessId"] },
        { title: "Credentials", fields: ["secret", "token"] },
        { title: "Behavior", fields: ["allowWrites"] },
      ],
    },
  },
  network: {
    allowedOrigins: [{ setting: "endpoint" }, { setting: "accessId" }],
    allowedMethods: ["GET", "POST"],
    browserManagedHeaders: ["date"],
  },
  tools: [{
    name: "query",
    runtime: "inner",
    script: "scripts/query.js",
    parameters: { type: "object", properties: {} },
  }],
}, {
  name: "settings-skill",
  displayName: "设置技能",
  scope: "global",
}, diagnostics);

assert.equal(plugin.tools[0].runtime, "inner");
assert.equal(plugin.tools[0].needsPage, false);
assert.deepEqual(plugin.network.allowedOrigins, [{ setting: "endpoint" }]);
assert.match(diagnostics.map(item => item.message).join("\n"), /必须指向 url 设置字段: accessId/);
assert.equal(plugin.settings.fields.find(field => field.key === "retries").default, null);
assert.deepEqual(plugin.settings.layout, {
  sections: [
    { title: "Connection", description: "Where requests run", fields: ["endpoint", "accessId"] },
    { title: "Credentials", description: "", fields: ["secret", "token"] },
    { title: "Behavior", description: "", fields: ["allowWrites"] },
  ],
});

const layoutDiagnostics = [];
const normalizedMalformedLayout = normalizeSkillSettings({
  fields: [
    { key: "first", type: "text" },
    { key: "second", type: "text" },
  ],
  layout: {
    sections: [
      { title: "One", fields: ["first", "missing", "first"] },
      { title: "Two", fields: ["first", "second"] },
      { title: "Empty", fields: ["missing"] },
      { title: "Broken", fields: "second" },
      { fields: ["second"] },
    ],
  },
}, layoutDiagnostics, { pluginId: "layout-test" });
assert.deepEqual(normalizedMalformedLayout.layout, {
  sections: [
    { title: "One", description: "", fields: ["first"] },
    { title: "Two", description: "", fields: ["second"] },
  ],
});
const layoutMessages = layoutDiagnostics.map(item => item.message).join("\n");
assert.match(layoutMessages, /引用了未知字段: missing/);
assert.match(layoutMessages, /字段重复，已忽略: first/);
assert.match(layoutMessages, /Empty 没有有效字段/);
assert.match(layoutMessages, /Broken 的 fields 必须是数组/);
assert.match(layoutMessages, /分组缺少 title/);
assert.deepEqual(
  normalizeSkillSettings({ fields: [{ key: "legacy", type: "text" }] }).layout,
  { sections: [] },
  "legacy manifests without layout should keep the flat renderer contract",
);

assert.deepEqual(
  normalizeSkillSettingValue("true", { type: "boolean" }),
  { ok: false, reason: "type", expected: "boolean" },
  "boolean settings must not coerce strings",
);
assert.deepEqual(
  normalizeSkillSettingValue(true, { type: "number" }),
  { ok: false, reason: "type", expected: "number" },
  "number settings must not coerce booleans",
);
assert.deepEqual(
  normalizeSkillSettingValue({ value: "x" }, { type: "text" }),
  { ok: false, reason: "type", expected: "string" },
  "text settings must not stringify objects",
);
assert.deepEqual(
  normalizeSkillSettingValue(" https://example.test/api/#fragment ", { type: "url" }),
  { ok: true, value: "https://example.test/api" },
  "valid URL settings should still be canonicalized",
);

const defaultDiagnostics = [];
const strictDefaults = normalizeSkillSettings({
  fields: [
    { key: "flag", type: "boolean", default: "true" },
    { key: "count", type: "number", default: "3" },
    { key: "label", type: "text", default: { text: "wrong" } },
    { key: "mode", type: "select", options: ["safe"], default: 1 },
    { key: "credential", type: "secret", default: "must-not-be-stored" },
    { key: "patterned", type: "text", pattern: "[", default: "still-valid" },
  ],
}, defaultDiagnostics, { pluginId: "strict-defaults" });
const defaultsByKey = Object.fromEntries(strictDefaults.fields.map(item => [item.key, item.default]));
assert.deepEqual(defaultsByKey, {
  flag: false,
  count: null,
  label: "",
  mode: "",
  credential: "",
  patterned: "",
});
assert.equal(strictDefaults.fields.find(item => item.key === "patterned")?.pattern, "[", "an invalid manifest constraint must fail closed");
const defaultMessages = defaultDiagnostics.map(item => item.message).join("\n");
assert.match(defaultMessages, /flag 的 default 无效.*boolean/);
assert.match(defaultMessages, /count 的 default 无效.*number/);
assert.match(defaultMessages, /label 的 default 无效.*string/);
assert.match(defaultMessages, /mode 的 default 无效.*string/);
assert.match(defaultMessages, /credential 不能声明 default/);
assert.match(defaultMessages, /patterned 的 pattern 无效/);
assert.match(defaultMessages, /patterned 的 default 无效.*pattern 无效/);

const storageState = {};
const storage = {
  async get(key) {
    return { [key]: storageState[key] };
  },
  async set(values) {
    Object.assign(storageState, structuredClone(values));
  },
  async remove(key) {
    delete storageState[key];
  },
};
let clock = 0;
let activePlugins = [plugin];
const service = createSkillSettingsService({
  storage,
  listSkillManifests: async () => activePlugins,
  now: () => `2026-07-17T00:00:0${++clock}.000Z`,
});

const initial = await service.list();
assert.equal(initial.settings.length, 1);
assert.equal(initial.settings[0].configured, false);
assert.deepEqual(initial.settings[0].missing, ["endpoint", "accessId", "secret"]);
assert.deepEqual(initial.settings[0].layout, plugin.settings.layout, "Side Panel projection should preserve generic section layout");
assert.equal(field(initial, "secret").value, "");
assert.equal(field(initial, "secret").hasValue, false);
assert.equal(field(initial, "retries").value, undefined, "optional number must not become zero");
assert.equal(field(initial, "mode").value, "safe");
assert.equal(field(initial, "allowWrites").value, false);

const saved = await service.save({
  pluginId: plugin.id,
  skillName: plugin.skillName,
  values: {
    endpoint: "https://example.test/api/",
    accessId: "ak-id",
    secret: "ak-secret",
    retries: null,
  },
});
assert.equal(saved.setting.configured, true);
assert.equal(field({ settings: [saved.setting] }, "secret").hasValue, true);
assert.equal(field({ settings: [saved.setting] }, "secret").value, "ak-secret");
assert.equal(field({ settings: [saved.setting] }, "token").hasValue, false, "optional linked secret is not required on first save");
assert.equal(field({ settings: [saved.setting] }, "endpoint").value, "https://example.test/api");
assert.equal(storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill::settings-example"].values.secret, "ak-secret");
assert.equal(Object.hasOwn(storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill::settings-example"], "layout"), false, "presentation layout must not enter persisted setting records");

const publicConfig = await service.getExecutionConfig(plugin);
assert.equal(publicConfig.endpoint, "https://example.test/api");
assert.equal(publicConfig.mode, "safe");
assert.equal(publicConfig.allowWrites, false);
assert.equal(Object.hasOwn(publicConfig, "secret"), false);
assert.equal(Object.hasOwn(publicConfig, "token"), false);
assert.equal(Object.hasOwn(publicConfig, "retries"), false);
assert.equal(Object.hasOwn(publicConfig, "layout"), false, "presentation layout must not enter execution config");

const privateConfig = await service.getExecutionConfig(plugin, { includeSecrets: true });
assert.equal(privateConfig.secret, "ak-secret");
assert.equal(field(await service.list(), "secret").value, "ak-secret", "Side Panel settings should receive the saved secret value");

const stateBeforeInvalidWrites = structuredClone(storageState);
for (const [fieldKey, value] of [
  ["endpoint", ["https://wrong.example"]],
  ["accessId", { value: "wrong" }],
  ["secret", { value: "wrong" }],
  ["retries", true],
  ["mode", 1],
  ["allowWrites", "true"],
]) {
  await assert.rejects(
    service.save({
      pluginId: plugin.id,
      skillName: plugin.skillName,
      values: { [fieldKey]: value },
    }),
    error => error?.code === "SKILL_SETTING_VALUE_INVALID" && error?.details?.field === fieldKey,
    `${fieldKey} should reject values with the wrong JSON type`,
  );
}
assert.deepEqual(storageState, stateBeforeInvalidWrites, "rejected settings writes must leave the complete stored record unchanged");

await assert.rejects(
  service.save({
    pluginId: plugin.id,
    skillName: plugin.skillName,
    values: { endpoint: "https://next.example.test/api" },
  }),
  error => error?.code === "SKILL_SETTING_SECRET_REENTRY_REQUIRED" && error?.details?.field === "secret",
);

await service.save({
  pluginId: plugin.id,
  skillName: plugin.skillName,
  values: {
    endpoint: "https://next.example.test/api",
    secret: "rotated-secret",
    token: "temporary-token",
    retries: 3,
  },
});
await service.save({
  pluginId: plugin.id,
  skillName: plugin.skillName,
  values: { token: "", retries: null, allowWrites: true },
});
const afterClear = await service.getExecutionConfig(plugin, { includeSecrets: true });
assert.equal(afterClear.secret, "rotated-secret");
assert.equal(Object.hasOwn(afterClear, "token"), false);
assert.equal(Object.hasOwn(afterClear, "retries"), false);
assert.equal(afterClear.allowWrites, true);

await assert.rejects(
  service.save({
    pluginId: plugin.id,
    skillName: plugin.skillName,
    values: {},
    clearSecrets: ["secret"],
  }),
  error => error?.code === "SKILL_SETTINGS_INVALID" && error?.details?.missing?.includes("secret"),
);
assert.equal((await service.getExecutionConfig(plugin, { includeSecrets: true })).secret, "rotated-secret", "failed writes must not alter storage");

await Promise.all([
  service.save({ pluginId: plugin.id, skillName: plugin.skillName, values: { retries: 2 } }),
  service.save({ pluginId: plugin.id, skillName: plugin.skillName, values: { allowWrites: false } }),
]);
const afterConcurrentWrites = await service.getExecutionConfig(plugin, { includeSecrets: true });
assert.equal(afterConcurrentWrites.retries, 2);
assert.equal(afterConcurrentWrites.allowWrites, false);

const renamedPlugin = {
  ...plugin,
  skillName: "settings-skill-renamed",
  skillDisplayName: "设置技能（已重命名）",
};
activePlugins = [renamedPlugin];
const renamed = await service.reconcile({
  plugins: activePlugins,
  previousSkillName: plugin.skillName,
  skillName: renamedPlugin.skillName,
});
assert.deepEqual(
  { changed: renamed.changed, migrated: renamed.migrated, removed: renamed.removed },
  { changed: true, migrated: 1, removed: 0 },
  "a Skill rename should migrate matching Plugin settings at the registry boundary",
);
assert.equal(storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill::settings-example"], undefined);
assert.equal(
  storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill-renamed::settings-example"].values.secret,
  "rotated-secret",
);
assert.equal(
  (await service.getExecutionConfig(renamedPlugin, { includeSecrets: true })).secret,
  "rotated-secret",
  "renaming a Skill must not silently discard its active Plugin configuration",
);

storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill-renamed::settings-example"].values.obsoleteSecret = "must-be-removed";
const schemaReconciled = await service.reconcile({ plugins: activePlugins });
assert.equal(schemaReconciled.prunedValues, 1);
assert.equal(
  Object.hasOwn(storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill-renamed::settings-example"].values, "obsoleteSecret"),
  false,
  "settings removed from a manifest must not leave unreachable secrets in storage",
);

const evolvedPlugin = structuredClone(renamedPlugin);
evolvedPlugin.settings.fields = evolvedPlugin.settings.fields.map(item => item.key === "retries"
  ? {
      ...item,
      type: "select",
      default: "safe",
      pattern: "",
      min: null,
      max: null,
      step: null,
      options: [{ value: "safe", label: "safe" }],
    }
  : item);
activePlugins = [evolvedPlugin];
const evolvedSchemaReconciled = await service.reconcile({ plugins: activePlugins });
assert.equal(evolvedSchemaReconciled.prunedValues, 1, "a persisted value invalid under a new field type must be pruned");
assert.equal(
  Object.hasOwn(storageState[SKILL_SETTINGS_STORAGE_KEY].records["settings-skill-renamed::settings-example"].values, "retries"),
  false,
);
assert.equal(
  (await service.getExecutionConfig(evolvedPlugin)).retries,
  "safe",
  "execution should use the new schema default instead of leaking the old typed value",
);

activePlugins = [];
const uninstalled = await service.reconcile({ plugins: activePlugins });
assert.equal(uninstalled.removed, 1);
assert.equal(storageState[SKILL_SETTINGS_STORAGE_KEY], undefined, "uninstalling a Skill must remove its local settings and secrets");

activePlugins = [renamedPlugin];
const reinstalled = await service.list();
assert.equal(reinstalled.settings[0].configured, false, "reinstalling the same Skill identity must not inherit deleted secrets");
assert.equal(field(reinstalled, "secret").value, "");
await assert.rejects(
  service.getExecutionConfig(renamedPlugin, { includeSecrets: true }),
  error => error?.code === "SKILL_SETTINGS_REQUIRED" && error?.details?.missing?.includes("secret"),
);

await service.save({
  pluginId: renamedPlugin.id,
  skillName: renamedPlugin.skillName,
  values: {
    endpoint: "https://reinstalled.example.test",
    accessId: "new-ak",
    secret: "new-secret",
  },
});
const removed = await service.remove({ pluginId: renamedPlugin.id, skillName: renamedPlugin.skillName });
assert.equal(removed.setting.configured, false);
assert.equal(storageState[SKILL_SETTINGS_STORAGE_KEY], undefined);

console.log("plugin settings tests passed");

function field(result, key) {
  return result.settings[0].fields.find(item => item.key === key);
}
