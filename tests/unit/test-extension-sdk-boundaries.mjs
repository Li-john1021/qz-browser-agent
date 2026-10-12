import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateExtensionBoundaries } from "../../scripts/extension-boundaries.mjs";
import { capabilityBuildProfile, generateCapabilityCatalogs } from "../../scripts/capability-catalog.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qz-sdk-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); };
  await put("src/sdk/background.ts", "export interface ToolExtensionAPI {}\n");
  await put("src/sdk/sidepanel.ts", "export interface UiExtensionAPI {}\n");
  await put("src/sdk/shared/format.ts", "export const format = String;\n");
  await put("src/capabilities/example/index.ts", "export { default as tools } from './tools.js';\n");
  return { root, put, source: join(root, "src") };
}

test("extension imports use own context, shared code, explicit SDK entries and npm", async t => {
  const { source, put } = await fixture(t);
  await put("src/capabilities/example/value.ts", 'export const value = "ok";');
  await put("src/capabilities/example/helper.ts", "export interface Helper {}\n");
  await put("src/capabilities/example/tools.ts", `
    import type { ToolExtensionAPI } from '#sdk/background';
    import { format } from '#sdk/shared/format';
    import { value } from './value.js';
    import dependency from '@vendor/package/helpers';
    export type { Helper } from './helper.js';
    type Lazy = import('./helper.js').Helper;
    const misleading = 'import("../../background/private.js")';
    // import type { Private } from '../../background/private.js';
    export default (qz: ToolExtensionAPI) => void format(value);
  `);
  assert.doesNotThrow(() => validateExtensionBoundaries(source));
});

test("all module syntax, including erased type edges, obeys the same SDK boundary", async t => {
  const { source, put } = await fixture(t);
  const file = "src/capabilities/example/tools.ts";
  await put("src/capabilities/example/view/state.ts", 'export type { UiExtensionAPI as UI } from "#sdk/sidepanel";');
  for (const [description, statement, diagnostic] of [
    ["private relative type", 'import type { State } from "../../background/private.js";', /inside the package/],
    ["sibling package", 'export { value } from "../other/value.js";', /inside the package/],
    ["transitive other context", 'import type { UI } from "./view/state.js";', /another runtime context/],
    ["other SDK context", 'type UI = import("#sdk/sidepanel").UiExtensionAPI;', /another runtime context/],
    ["arbitrary framework alias", 'import "#framework/shared/format";', /declared SDK/],
    ["internal generated alias", 'export * from "#capabilities/tools";', /declared SDK/],
    ["missing SDK", 'import "#sdk/background/missing";', /unknown SDK/],
    ["SDK traversal", 'import "#sdk/shared/../background";', /invalid SDK path/],
    ["dynamic private import", 'await import("../../background/private.js");', /inside the package/],
    ["CommonJS private import", 'const state = require("../../background/private.js");', /inside the package/],
    ["import equals", 'import state = require("../../background/private.js");', /inside the package/],
    ["computed module", 'await import("./" + source);', /must be static/],
    ["absolute path", 'import "/tmp/private.js";', /declared SDK/],
  ]) {
    await put(file, statement);
    assert.throws(() => validateExtensionBoundaries(source), diagnostic, description);
  }
  await rm(join(source, "capabilities/example/view"), { recursive: true });
  await put(file, 'export default () => {};');
  await put("src/capabilities/example/index.ts", "export { default as tools } from './tools.js'; export { default as metadata } from './value.js';");
  await put("src/capabilities/example/value.ts", 'import type { API } from "#sdk/background";');
  assert.throws(() => validateExtensionBoundaries(source), /another runtime context/, "shared source cannot depend on a host, even by type");
});

test("build and typecheck discovery reject violations before publishing generated output", async t => {
  const { root, source, put } = await fixture(t);
  const entry = "src/capabilities/example/tools.ts";
  await put(entry, 'export default () => {};');
  assert.doesNotThrow(() => capabilityBuildProfile(source));
  await put(entry, 'import "#framework/background/private"; export default () => {};');
  assert.throws(() => capabilityBuildProfile(source), /Extension boundary/);
  assert.throws(() => generateCapabilityCatalogs(root), /Extension boundary/);
  assert.equal(existsSync(join(root, "dist")), false);
  await put(entry, 'export default () => {};');
  assert.doesNotThrow(() => capabilityBuildProfile(source), "watch rebuild rechecks changed files rather than retaining a failed verdict");
});

test("nested helper symlinks cannot bypass the package boundary", async t => {
  const { root, source, put } = await fixture(t);
  await put("src/capabilities/example/tools.ts", 'import "./helper.js"; export default () => {};');
  await put("src/private.ts", "export const privateValue = 1;");
  await symlink(join(root, "src/private.ts"), join(root, "src/capabilities/example/helper.ts"));
  assert.throws(() => validateExtensionBoundaries(source), /symlink is not allowed/);
});

test("one index declares arbitrary nested implementations without evaluating or importing the index", async t => {
  const { source, put } = await fixture(t);
  await put("src/capabilities/example/index.ts", "export { default as tools } from './commands/execute.js'; export { default as ui } from './panels/view.js';");
  await put("src/capabilities/example/commands/execute.ts", "import '../values.js'; export default () => {}; ");
  await put("src/capabilities/example/panels/view.ts", "import '../values.js'; export default () => {}; ");
  await put("src/capabilities/example/values.ts", 'import "#sdk/shared/format"; export const value = 1;');
  const graph = validateExtensionBoundaries(source);
  assert.equal(graph.entries.tools[0], join(source, "capabilities/example/commands/execute.ts"));
  for (const context of ["background", "sidepanel"]) assert.ok(graph.contexts[context].has(join(source, "capabilities/example/values.ts")));
  assert.equal(graph.declarations.size, 1);
  await put("src/capabilities/example/values.ts", 'import type { ToolExtensionAPI } from "#sdk/background";');
  assert.throws(() => validateExtensionBoundaries(source), /values\.ts \(sidepanel\).*another runtime context/);
  await put("src/capabilities/example/values.ts", 'export * from "./index.js";');
  assert.throws(() => validateExtensionBoundaries(source), /index.ts is a declaration/);
  await put("src/capabilities/example/values.ts", 'export const value = 1;');
  await put("src/capabilities/example/forgotten.ts", 'export const orphan = 1;');
  assert.throws(() => validateExtensionBoundaries(source), /unreachable from index.ts: forgotten.ts/);
});

test("entry declarations reject execution, ambiguous exports and targets outside their own package", async t => {
  const { source, put } = await fixture(t);
  await put("src/capabilities/example/tools.ts", "export default () => {};");
  for (const [content, diagnostic] of [
    ["export default {};", /use only export/],
    ["import './tools.js'; export { default as tools } from './tools.js';", /use only export/],
    ["globalThis.sideEffect = true; export { default as tools } from './tools.js';", /use only export/],
    ["export * from './tools.js';", /use only export/],
    ["export { default as unknown } from './tools.js';", /Unknown capability channel/],
    ["export { tools } from './tools.js';", /use only export/],
    ["export { default as tools } from './tools.js'; export { default as tools } from './tools.js';", /Duplicate/],
    ["export { default as tools } from '../other/tools.js';", /inside the package/],
    ["export { default as tools } from 'npm-extension';", /relative package paths/],
    ["export { default as tools } from '.tools.js';", /relative package paths/],
    ["export { default as tools } from './tools';", /emitted .js extension/],
    ["export { default as tools } from './tools.ts';", /emitted .js extension/],
    ["export { default as tools } from './index.js';", /index.ts is a declaration/],
    ["export { default as tools } from './missing.js';", /missing TypeScript module/],
  ]) {
    await put("src/capabilities/example/index.ts", content);
    assert.throws(() => validateExtensionBoundaries(source), diagnostic, content);
  }
  await rm(join(source, "capabilities/example/index.ts"));
  assert.throws(() => validateExtensionBoundaries(source), /requires index.ts/);
});
