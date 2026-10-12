import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "acorn";
import { createRevisionFixtureAdapter } from "../tool-timeline/revision-fixture.mjs";

async function revision(t, files) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-revision-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "export const originalRevision = true;\n");
  }
  return { root, adapter: createRevisionFixtureAdapter(root) };
}

test("current revision fixtures keep their imports and bytes unchanged", async t => {
  const { adapter } = await revision(t, ["sidepanel/tools/tool-renderer.js", "sidepanel/tools/skill-tool-ui-registry.js"]);
  const source = 'import { setSkillToolUiCatalog } from "/extension/sidepanel/tools/skill-tool-ui-registry.js";\nconst renderer = await import("/extension/sidepanel/tools/tool-renderer.js");';
  assert.equal(adapter.source("fixture.js", source), source);
  assert.equal(adapter.moduleUrl("/extension/sidepanel/tools/tool-renderer.js"), "/extension/sidepanel/tools/tool-renderer.js");
});

test("historical revisions adapt static and dynamic imports without rewriting fixture data or production files", async t => {
  const { root, adapter } = await revision(t, ["sidepanel/tool-renderer.js", "sidepanel/plugin-ui-registry.js"]);
  const source = `import { enrichSkillToolIdentity, setSkillToolUiCatalog as setCatalog } from "/extension/sidepanel/tools/skill-tool-ui-registry.js";
const prose = 'setSkillToolUiCatalog /extension/sidepanel/tools/tool-renderer.js';
const renderer = await import("/extension/sidepanel/tools/tool-renderer.js");`;
  const adapted = adapter.source("fixture.js", source);
  const ast = parse(adapted, { ecmaVersion: "latest", sourceType: "module" });
  assert.equal(ast.body[0].source.value, "/extension/sidepanel/plugin-ui-registry.js");
  assert.deepEqual(ast.body[0].specifiers.map(item => [item.imported.name, item.local.name]), [
    ["enrichPluginToolIdentity", "enrichSkillToolIdentity"], ["setPluginToolUiCatalog", "setCatalog"],
  ]);
  assert.equal(ast.body[1].declarations[0].init.value, "setSkillToolUiCatalog /extension/sidepanel/tools/tool-renderer.js");
  assert.equal(ast.body[2].declarations[0].init.argument.source.value, "/extension/sidepanel/tool-renderer.js");
  assert.equal(adapter.moduleUrl("/extension/sidepanel/tools/tool-renderer.js"), "/extension/sidepanel/tool-renderer.js");
  assert.equal(await readFile(join(root, "sidepanel/plugin-ui-registry.js"), "utf8"), "export const originalRevision = true;\n");
});

for (const directory of ["sidepanel/ui", "sidepanel"]) {
  test(`UI primitive fixture imports use the revision's real ${directory} modules`, async t => {
    const { root, adapter } = await revision(t, [
      `${directory}/scroll-tail-controller.js`, `${directory}/ui-utils.js`,
    ]);
    const source = `import { scrollToTail } from "/extension/sidepanel/ui/scroll-tail-controller.js";
const utils = await import("/extension/sidepanel/ui/ui-utils.js");
const prose = "/extension/sidepanel/ui/ui-utils.js";`;
    const adapted = adapter.source("fixture.js", source);
    const ast = parse(adapted, { ecmaVersion: "latest", sourceType: "module" });
    assert.equal(ast.body[0].source.value, `/extension/${directory}/scroll-tail-controller.js`);
    assert.equal(ast.body[1].declarations[0].init.argument.source.value, `/extension/${directory}/ui-utils.js`);
    assert.equal(ast.body[2].declarations[0].init.value, "/extension/sidepanel/ui/ui-utils.js");
    assert.equal(adapter.moduleUrl("/extension/sidepanel/ui/ui-utils.js"), `/extension/${directory}/ui-utils.js`);
    if (directory === "sidepanel/ui") assert.equal(adapted, source);
    for (const file of ["scroll-tail-controller.js", "ui-utils.js"]) {
      assert.equal(await readFile(join(root, directory, file), "utf8"), "export const originalRevision = true;\n");
    }
  });
}

test("inline module adaptation preserves surrounding HTML and missing revision modules fail clearly", async t => {
  const { adapter } = await revision(t, ["shared/plugin-renderers.js"]);
  const source = '<p>listSkillRendererDefinitions</p><script type="module">import { listSkillRendererDefinitions } from "/extension/shared/skills/skill-renderers.js";</script>';
  assert.equal(adapter.source("fixture.html", source), '<p>listSkillRendererDefinitions</p><script type="module">import { listPluginRendererDefinitions as listSkillRendererDefinitions } from "/extension/shared/plugin-renderers.js";</script>');
  assert.throws(() => adapter.moduleUrl("/extension/sidepanel/tools/tool-renderer.js"), /Revision is missing fixture module/);
  assert.throws(() => adapter.moduleUrl("/extension/sidepanel/ui/ui-utils.js"), /Revision is missing fixture module/);
});
