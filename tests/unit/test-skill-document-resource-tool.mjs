import assert from "node:assert/strict";

import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";

const storedSkill = normalizeModernSkill({
  name: "document-resource-skill",
  description: "Loads a bundled workbook.",
  content: "# Document resource",
  resources: [{
    path: "references/apps.xlsx",
    type: "asset",
    encoding: "base64",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 4,
    content: "UEsDBA==",
  }],
});

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        const values = { _skills: { [storedSkill.name]: storedSkill } };
        if (typeof key === "string") return { [key]: values[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, values[item]]));
        return values;
      },
      async set() {},
    },
  },
};

const tools = await import("../../src/background/tools/runtime.js");
const calls = [];
const runtime = tools.createToolRuntime({
  skills: {
    async loadDocumentResource(input, execution) {
      calls.push({ input, execution });
      return {
        name: input.skill.name,
        path: input.path,
        format: "xlsx",
        content: "name\tstatus\nA\tok",
        document: { docModelId: "model_skill_apps" },
      };
    },
  },
});

const loaded = await runtime.execute(
  "load_skill_resource",
  { name: storedSkill.name, path: "references/apps.xlsx" },
  null,
  { source: "test", sessionId: "session-doc-resource", runId: "run-doc-resource" },
);
assert.equal(loaded.document.docModelId, "model_skill_apps");
assert.equal(calls.length, 1);
assert.equal(calls[0].input.resource.encoding, "base64");
assert.equal(calls[0].execution.context.sessionId, "session-doc-resource");

const skillSummary = await runtime.execute(
  "load_skill",
  { name: storedSkill.name, includeResources: true },
  null,
  { source: "test", sessionId: "session-doc-resource" },
);
assert.equal(skillSummary.resources[0].encoding, "base64");
assert.equal(skillSummary.resources[0].size, 4);
assert.equal(Object.hasOwn(skillSummary.resources[0], "content"), false, "binary base64 must not leak into model context");

console.log("skill document resource tool tests passed");
