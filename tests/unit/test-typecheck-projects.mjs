import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { typecheckProjects } from "../../scripts/typecheck.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("project references discover new parallel capabilities and reject unassigned or untyped source", async t => {
  const root = await fixture(t);
  await cp(join(ROOT, "tsconfig.json"), join(root, "tsconfig.json"));
  await cp(join(ROOT, "config"), join(root, "config"), { recursive: true });
  const sources = {
    background: ["src/background/main.ts", "src/shared/common.ts", "src/capabilities/new/execute.ts", "src/capabilities/new/metadata.ts"],
    dom: ["src/content/main.ts", "src/sidepanel/main.ts", "src/capabilities/new/view.ts", "src/capabilities/new/metadata.ts"],
    worker: ["src/workers/parser.ts"],
    tests: ["tests/types/contract.ts"],
  };
  for (const file of Object.values(sources).flat()) await source(root, file, "export {};\n");
  await source(root, "src/capabilities/new/index.ts", "export { default as tools } from './execute.js'; export { default as ui } from './view.js'; export { default as metadata } from './metadata.js';");
  const projects = typecheckProjects(root);
  assert.equal(projects.length, 4);
  for (const { config, files } of projects) {
    assert.deepEqual(files.sort(), sources[basename(config, ".json")].map(normalize).sort());
  }
  await source(root, "src/unassigned.ts", "export {};\n");
  assert.throws(() => typecheckProjects(root), /sources lack a runtime context: src[/\\]unassigned\.ts/);
  await rm(join(root, "src/unassigned.ts"));
  await source(root, "src/capabilities/new/legacy.js", "export {};\n");
  assert.throws(() => typecheckProjects(root), /First-party extension code requires.*legacy\.js/);
});

test("context projects preserve browser globals without leaking DOM into Background or Chrome into plain workers", async t => {
  const root = await fixture(t);
  for (const [name, valid, invalid, missing] of [
    ["background", "chrome.runtime.id; self.location;", "document.createElement('div');", "document"],
    ["dom", "chrome.runtime.id; document.createElement('div');", "process.version;", "process"],
    ["worker", "self.location; new TextDecoder();", "chrome.runtime.id;", "chrome"],
    ["tests", "document.createElement('div');", "chrome.runtime.id;", "chrome"],
  ]) {
    const directory = join(root, name);
    await source(directory, "tsconfig.json", JSON.stringify({
      extends: join(ROOT, `config/typescript/${name}.json`),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules/@types")] },
      files: [],
      include: ["probe.ts"],
    }));
    const compile = () => spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", directory], {
      encoding: "utf8", timeout: 20_000,
    });
    await source(directory, "probe.ts", valid);
    const accepted = compile();
    assert.equal(accepted.status, 0, `${name}: ${accepted.stdout}${accepted.stderr}`);
    await source(directory, "probe.ts", invalid);
    const rejected = compile();
    assert.notEqual(rejected.status, 0, `${name} must reject ${missing}`);
    assert.match(rejected.stdout + rejected.stderr, new RegExp(`Cannot find name '${missing}'`));
  }
  const configuration = JSON.parse(await readFile(join(ROOT, "tsconfig.json"), "utf8"));
  assert.equal(configuration.compilerOptions.strict, true);
  assert.equal(configuration.compilerOptions.noEmit, true);
  const solution = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.json")], {
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(solution.status, 0, `the editor solution must be valid without composite output: ${solution.stdout}${solution.stderr}`);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou typecheck "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function source(root, name, content) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
