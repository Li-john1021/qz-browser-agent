import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";

function pluginSkill(name, id) {
  return {
    name,
    description: name,
    content: "",
    metadata: {},
    scope: "resident",
    status: "active",
    domains: [],
    urlPatterns: [],
    excludePatterns: [],
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    createdAt: "2026-07-14 10:00:00",
    updatedAt: "2026-07-14 10:00:00",
    resources: [
      {
        path: "plugin.json",
        type: "json",
        content: JSON.stringify({
          format: SKILL_MANIFEST_FORMAT,
          schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
          id,
          name,
          version: "1.0.0",
          tools: [{
            name: "ping",
            title: "Ping",
            description: "Ping",
            script: "scripts/ping.js",
            parameters: { type: "object", properties: {} },
          }],
        }),
      },
      { path: "scripts/ping.js", type: "script", content: "async () => ({ ok: true })" },
    ],
  };
}

const storage = {
  _skills: { "plugin-a-skill": pluginSkill("plugin-a-skill", "plugin-a") },
};
let reads = 0;
let blockedRead = 0;
let signalRead;
let releaseRead;

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        reads += 1;
        const snapshot = structuredClone(storage[key]);
        if (reads === blockedRead) {
          signalRead?.();
          await new Promise(resolve => { releaseRead = resolve; });
        }
        return { [key]: snapshot };
      },
      async set(value) {
        Object.assign(storage, value);
      },
    },
  },
};

const runtime = await import("../../src/background/skills/skill-tool-runtime.ts");
const initialCandidate = await runtime.prepareSkillToolRegistryFromStorage();
assert.equal(initialCandidate.plugins.some(plugin => plugin.id === "plugin-a"), true);
assert.equal(runtime.getSkillToolRegistrySnapshot().version, 0, "preparing must not publish candidate state");
const initialSnapshot = runtime.commitSkillToolRegistryCandidate(initialCandidate, { reason: "initial" });
assert.equal(initialSnapshot.version, 1);

const readStarted = new Promise(resolve => { signalRead = resolve; });
blockedRead = reads + 1;
const first = runtime.prepareSkillToolRegistryFromStorage();
await readStarted;
storage._skills["plugin-b-skill"] = pluginSkill("plugin-b-skill", "plugin-b");
const second = runtime.prepareSkillToolRegistryFromStorage();
releaseRead();

const [firstCandidate, secondCandidate] = await Promise.all([first, second]);
assert.equal(firstCandidate.plugins.some(plugin => plugin.id === "plugin-b"), false);
assert.equal(secondCandidate.plugins.some(plugin => plugin.id === "plugin-b"), true);
assert.equal(
  runtime.getSkillToolRegistrySnapshot().version,
  initialSnapshot.version,
  "concurrent preparation must leave the committed registry untouched",
);
assert.equal(reads, 3, "each preparation must read one coherent storage snapshot");

const firstSnapshot = runtime.commitSkillToolRegistryCandidate(firstCandidate, { reason: "first_change" });
const secondSnapshot = runtime.commitSkillToolRegistryCandidate(secondCandidate, { reason: "second_change" });
assert.equal(firstSnapshot.plugins.some(plugin => plugin.id === "plugin-b"), false);
assert.equal(secondSnapshot.plugins.some(plugin => plugin.id === "plugin-b"), true);
assert.equal(secondSnapshot.version, firstSnapshot.version + 1);

const beforeInvalidCommit = runtime.getSkillToolRegistrySnapshot();
assert.throws(
  () => runtime.commitSkillToolRegistryCandidate({ plugins: [], diagnostics: [], toolIndex: {} }),
  /invalid Skill tool registry candidate/,
);
assert.deepEqual(
  runtime.getSkillToolRegistrySnapshot(),
  beforeInvalidCommit,
  "an invalid candidate must fail before mutating committed state",
);

const pluginRuntimeSource = readFileSync(new URL("../../src/background/skills/skill-tool-runtime.ts", import.meta.url), "utf8");
const toolsSource = readFileSync(new URL("../../src/background/tools/runtime.ts", import.meta.url), "utf8");
const agentSource = readFileSync(new URL("../../src/background/agent/agent.ts", import.meta.url), "utf8");
const mcpRuntimeSource = readFileSync(new URL("../../src/background/mcp/mcp-runtime.ts", import.meta.url), "utf8");
const serviceWorkerSource = readFileSync(new URL("../../src/background/service-worker.ts", import.meta.url), "utf8");
assert.doesNotMatch(pluginRuntimeSource, /refreshPluginRegistryFromStorage|pluginRefreshQueue/);
assert.doesNotMatch(toolsSource, /refreshPluginRegistryFromStorage|execute_tool_lookup/);
assert.doesNotMatch(agentSource, /refreshPluginRegistryFromStorage|commitSkillToolRegistryCandidate|prepareSkillToolRegistryFromStorage/);
assert.doesNotMatch(mcpRuntimeSource, /refreshRegistry/);
assert.match(serviceWorkerSource, /prepareSkillToolRegistryFromStorage[\s\S]*skillSettings\.reconcile[\s\S]*commitSkillToolRegistryCandidate/);
assert.match(serviceWorkerSource, /skillRegistryLifecycleQueue\.run/);
assert.match(serviceWorkerSource, /listSkillManifests:\s*\(\)\s*=>\s*getSkillToolRegistrySnapshot\(\)\.plugins/);
assert.match(serviceWorkerSource, /runSkillSettingsRequest\("skill_settings_(?:list|save|remove)"/);
assert.doesNotMatch(serviceWorkerSource, /listSkillManifests:\s*async[\s\S]{0,160}ensureSkillToolRegistryReady/);

console.log("plugin registry refresh tests passed");
