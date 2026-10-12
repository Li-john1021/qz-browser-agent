import assert from "node:assert/strict";

const storageData = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]));
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

const tools = await import("../../src/background/tools/runtime.js");
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const managementSkill = await import("../../src/capabilities/settings/embedded-skill.js");

await runtime.commitSkillToolRegistryCandidate(
  await runtime.prepareSkillToolRegistryFromStorage(),
  { reason: "test_llm_facing_time_units" },
);
const schemas = new Map(tools.getToolSchemas({
  loadedPluginSkillNames: [managementSkill.BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME],
}).map(item => [item.function.name, item.function]));

function props(toolName) {
  const schema = schemas.get(toolName);
  assert.ok(schema, `${toolName} should be exposed`);
  return schema.parameters.properties || {};
}

function assertSecondsProperty(toolName, propertyName) {
  const property = props(toolName)[propertyName];
  assert.ok(property, `${toolName}.${propertyName} should exist`);
  assert.match(property.description || "", /秒/, `${toolName}.${propertyName} should describe seconds`);
  assert.doesNotMatch(property.description || "", /毫秒|单位 ms|ms，|ms。/, `${toolName}.${propertyName} should not describe milliseconds`);
}

assertSecondsProperty("wait", "seconds");
assert.equal(Object.prototype.hasOwnProperty.call(props("wait"), "ms"), false, "wait should not expose ms");
assert.deepEqual(schemas.get("wait").parameters.required, ["seconds"], "relative wait should keep one required duration field");

assert.ok(props("wait_until").until, "wait_until.until should exist");
assert.deepEqual(schemas.get("wait_until").parameters.required, ["until"], "absolute wait should require exactly one time field");
assert.equal(schemas.get("wait_until").parameters.anyOf, undefined, "wait_until should not expose a fragile union schema");
assert.match(props("wait_until").until.description || "", /ISO 8601.*时区|时区.*ISO 8601/, "wait_until should make timezone semantics explicit");
assert.equal(Object.prototype.hasOwnProperty.call(props("wait_until"), "seconds"), false, "wait_until should not mix relative and absolute time fields");

assertSecondsProperty("wait_for_navigation", "timeout");
assertSecondsProperty("wait_for_element", "timeout");
assertSecondsProperty("wait_for_element", "intervalSeconds");
assert.equal(Object.prototype.hasOwnProperty.call(props("wait_for_element"), "interval"), false, "wait_for_element should not expose interval ms");

assertSecondsProperty("wait_for_response", "timeout");
assertSecondsProperty("wait_for_network_idle", "timeout");
assertSecondsProperty("wait_for_network_idle", "idleSeconds");
assert.equal(Object.prototype.hasOwnProperty.call(props("wait_for_network_idle"), "idleMs"), false, "wait_for_network_idle should not expose idleMs");

assertSecondsProperty("run_script", "timeout");
assertSecondsProperty("manage_sessions", "timeout");
assert.equal(Object.prototype.hasOwnProperty.call(props("manage_sessions"), "timeoutMs"), false, "manage_sessions should not expose timeoutMs");
assert.match(
  props("manage_sessions").timeout.description || "",
  /<=0.*无限等待|无限等待.*<=0/,
  "manage_sessions timeout should document <=0 as infinite wait",
);

assertSecondsProperty("manage_goal", "timeout");
assertSecondsProperty("qingzhou_management__manage_guardrails", "minOpenIntervalSeconds");
assert.equal(Object.prototype.hasOwnProperty.call(props("qingzhou_management__manage_guardrails"), "minOpenIntervalMs"), false, "manage_guardrails should not expose minOpenIntervalMs");

assertSecondsProperty("browse_history", "startTime");
assertSecondsProperty("browse_history", "endTime");

const badTimeFields = [];
for (const [toolName, schema] of schemas) {
  for (const key of Object.keys(schema.parameters?.properties || {})) {
    if (["timeoutMs", "idleMs", "intervalMs", "minOpenIntervalMs"].includes(key)) {
      badTimeFields.push(`${toolName}.${key}`);
    }
  }
}
assert.deepEqual(badTimeFields, [], "LLM-facing tool schemas should not expose millisecond aliases");

const observedSessionWaits = [];
const toolRuntime = tools.createToolRuntime({
  sessions: {
    async waitSessions(input) {
      observedSessionWaits.push(input);
      return { ok: true, timeoutMs: input.timeoutMs };
    },
  },
});

await toolRuntime.execute("manage_sessions", { action: "wait", sessionIds: ["child-default"] }, null, {});
await toolRuntime.execute("manage_sessions", { action: "wait", sessionIds: ["child-zero"], timeout: 0 }, null, {});
await toolRuntime.execute("manage_sessions", { action: "wait", sessionIds: ["child-negative"], timeout: -1 }, null, {});
await toolRuntime.execute("manage_sessions", { action: "wait", sessionIds: ["child-positive"], timeout: 2 }, null, {});

assert.deepEqual(
  observedSessionWaits.map(item => item.timeoutMs),
  [0, 0, 0, 2000],
  "manage_sessions wait should pass timeout <=0 as infinite wait and positive timeout as seconds",
);
console.log("llm-facing time unit tests passed");
