import assert from "node:assert/strict";
import { normalizeToolIdentitySnapshot, toolIdentityEventFields, toolIdentityMetaFromEvent } from "../../src/shared/tools/tool-identity.js";
import { toolIdentity } from "../../src/shared/tools/tool-metadata.js";
import { enrichSkillToolIdentity, getSkillToolUiMeta, setSkillToolUiCatalog } from "../../src/sidepanel/tools/skill-tool-ui-registry.js";

const identity = { name: "example", rendererId: "table", capabilityId: "example", title: "Example", familyId: "other", familyTitle: "Other" };
const event = toolIdentityEventFields(identity);
assert.equal(toolIdentity(identity).rendererId, "table");
assert.equal(Object.hasOwn(toolIdentity({ name: "old" }), "rendererId"), false);
assert.equal(event.toolRendererId, "table");
assert.deepEqual(normalizeToolIdentitySnapshot({ name: "example", ...toolIdentityMetaFromEvent(event) }), identity);
assert.equal(normalizeToolIdentitySnapshot({}, event).rendererId, "table");
assert.equal(Object.hasOwn(normalizeToolIdentitySnapshot({ name: "old" }), "rendererId"), false);
assert.equal(Object.hasOwn(toolIdentityEventFields({ name: "old" }), "toolRendererId"), false);

const renderer = { type: "table", sourcePath: "rows" };
setSkillToolUiCatalog({ plugins: [{ id: "plugin", tools: [{ name: "plugin__table", renderer }, { name: "plugin__custom", rendererId: "missing-extension" }] }] });
assert.deepEqual(getSkillToolUiMeta("plugin__table").renderer, renderer, "declarative Skill IR remains independent of code renderer IDs");
assert.equal(enrichSkillToolIdentity({ name: "plugin__custom" }).rendererId, "missing-extension", "unknown IDs survive serialization for readable fallback");
assert.equal(enrichSkillToolIdentity({ name: "old", result: { _plugin: { rendererId: "table" } } }).rendererId, "table", "historical result metadata retains its renderer reference");
setSkillToolUiCatalog({ plugins: [{ id: "partial", tools: [{ name: "partial", title: "Catalog title", rendererId: "table" }] }] });
assert.equal(enrichSkillToolIdentity({ name: "partial", result: { _plugin: { localName: "result" } } }).title, "Catalog title", "partial historical metadata must not erase catalog identity");
assert.equal(enrichSkillToolIdentity({ name: "partial", result: { _plugin: "invalid", result: { _plugin: { rendererId: "nested" } } } }).rendererId, "nested", "invalid outer metadata does not hide valid nested metadata");
for (const contributions of [null, [], { plugins: [null, { tools: [null, {}, { name: "valid" }] }] }]) {
  assert.doesNotThrow(() => setSkillToolUiCatalog(contributions));
}
setSkillToolUiCatalog({});
console.log("renderer identity protocol tests passed");
