import assert from "node:assert/strict";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import {
  commitSkillToolRegistryCandidate,
  executeSkillTool,
  getActiveSkillToolSchemasSync,
  prepareSkillToolRegistryFromSkills,
} from "../../src/background/skills/skill-tool-runtime.js";

const manifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "runtime-example",
  displayName: "Runtime Example",
  settings: {
    fields: [
      { key: "endpoint", type: "url", required: true },
      { key: "token", type: "secret", required: true },
    ],
  },
  network: {
    allowedOrigins: [{ setting: "endpoint" }],
    allowedMethods: ["GET"],
  },
  tools: [
    {
      name: "inner_query",
      title: "Inner query",
      runtime: "inner",
      script: "scripts/runtime.js",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
    {
      name: "page_check",
      title: "Page check",
      runtime: "page",
      script: "scripts/runtime.js",
      parameters: { type: "object", properties: {} },
    },
  ],
};

commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills([{
  name: "runtime-example-skill",
  displayName: "Runtime Example Skill",
  description: "runtime contract",
  scope: "resident",
  format: QINGZHOU_SKILL_FORMAT,
  schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(manifest) },
    { path: "scripts/runtime.js", type: "script", content: "async () => ({ ok: true })" },
  ],
}]));

const schemas = getActiveSkillToolSchemasSync({});
const innerSchema = schemas.find(item => item.function.name === "runtime_example__inner_query");
assert.ok(innerSchema);
assert.equal(Object.hasOwn(innerSchema.function.parameters.properties, "tabId"), false);
assert.match(innerSchema.function.description, /内部 Worker/);
assert.match(innerSchema.function.description, /\$plugin\.config/);

const configCalls = [];
const dispatches = [];
const skillSettings = {
  async getExecutionConfig(_plugin, options) {
    configCalls.push(options);
    return options.includeSecrets
      ? { endpoint: "https://api.example.test", token: "private-token" }
      : { endpoint: "https://api.example.test" };
  },
};
const dispatch = async (name, args, signal, context) => {
  dispatches.push({ name, args, signal, context });
  return { ok: true, hasResult: true, result: { runtime: args.target || "page" } };
};

const innerResult = await executeSkillTool(
  "runtime_example__inner_query",
  { timeout: 20, value: "hello" },
  null,
  { sessionId: "session-1", workingTabId: 42 },
  dispatch,
  { skillSettings },
);
assert.equal(configCalls[0].includeSecrets, true);
assert.equal(dispatches[0].name, "run_skill_script");
assert.equal(dispatches[0].args.target, "inner");
assert.equal(Object.hasOwn(dispatches[0].args, "tabId"), false);
assert.equal(dispatches[0].args.args.value, "hello");
assert.deepEqual(dispatches[0].args.args.$plugin.config, {
  endpoint: "https://api.example.test",
  token: "private-token",
});
assert.equal(dispatches[0].context.skillExecution.plugin.id, "runtime-example");
assert.equal(dispatches[0].context.skillExecution.config.token, "private-token");
assert.equal(innerResult._plugin.runtime, "inner");

await executeSkillTool(
  "runtime_example__page_check",
  { timeout: 10 },
  null,
  { sessionId: "session-1", workingTabId: 42 },
  dispatch,
  { skillSettings },
);
assert.equal(configCalls[1].includeSecrets, false);
assert.equal(dispatches[1].args.tabId, 42);
assert.equal(Object.hasOwn(dispatches[1].args, "target"), false);
assert.deepEqual(dispatches[1].args.args.$plugin.config, { endpoint: "https://api.example.test" });
assert.equal(Object.hasOwn(dispatches[1].context, "skillExecution"), false);

await assert.rejects(
  executeSkillTool(
    "runtime_example__inner_query",
    { timeout: 10 },
    null,
    {},
    dispatch,
  ),
  error => error?.code === "SKILL_SETTINGS_UNAVAILABLE",
);

console.log("plugin inner runtime tests passed");
