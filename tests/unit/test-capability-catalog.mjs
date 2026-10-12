import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { capabilityBuildProfile, capabilityUiAssets, discoverCapabilities, generateCapabilityCatalogs } from "../../scripts/capability-catalog.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("discovery sorts parallel capabilities and collects each runtime channel independently", async t => {
  const root = await fixture(t);
  for (const name of ["zebra", "alpha"]) {
    for (const entry of ["skills", "skill-hosts", "tools", "providers", "presets", "context", "observers", "renderers", "ui", "metadata", "translations", "locales", "codecs", "model-capabilities", "artifacts"]) {
      await contribution(root, `src/capabilities/${name}/${entry}.ts`, "export default [];\n");
    }
  }
  await put(root, "src/capabilities/README.md", "Capability conventions\n");
  const discovered = discoverCapabilities(join(root, "src"));
  assert.equal(Object.keys(discovered).length, 15);
  for (const entries of Object.values(discovered)) {
    assert.equal(entries.length, 2);
    assert.match(entries[0], /[/\\]alpha[/\\]/);
    assert.match(entries[1], /[/\\]zebra[/\\]/);
  }
  assert.equal(Object.values(discoverCapabilities(join(root, "empty"))).flat().length, 0);
});

test("discovery rejects invalid names and symlinks at every discovery boundary", async t => {
  for (const name of ["Invalid", "bad_name", ".hidden"]) {
    const root = await fixture(t);
    await mkdir(join(root, "src/capabilities", name), { recursive: true });
    assert.throws(() => discoverCapabilities(join(root, "src")), /Invalid capability directory/);
  }
  for (const [label, location, target, directory] of [
    ["root", "src/capabilities", "outside", true],
    ["package", "src/capabilities/linked", "outside", true],
    ["nested directory", "src/capabilities/linked/nested", "outside", true],
    ["entry", "src/capabilities/linked/tools.ts", "outside.ts", false],
    ["missing nested directory", "src/capabilities/linked/nested", "missing", true],
    ["missing entry", "src/capabilities/linked/tools.ts", "missing.ts", false],
  ]) {
    await t.test(label, async t => {
      const root = await fixture(t);
      if (target === "outside") await mkdir(join(root, target));
      if (target === "outside.ts") await put(root, target, "export default () => {};\n");
      await mkdir(dirname(join(root, location)), { recursive: true });
      await symlink(join(root, target), join(root, location), directory ? "dir" : "file");
      assert.throws(() => discoverCapabilities(join(root, "src")), /symlink|Invalid capability entry/);
    });
  }
});

test("generation is deterministic, follows additions and removals, and writes only under dist", async t => {
  const root = await fixture(t);
  await contribution(root, "src/capabilities/alpha/tools.ts", "export default () => {};\n");
  const before = await tree(join(root, "src"));
  generateCapabilityCatalogs(root);
  const first = await tree(join(root, "dist"));
  generateCapabilityCatalogs(root);
  assert.deepEqual(await tree(join(root, "dist")), first);
  assert.deepEqual(await tree(join(root, "src")), before);
  assert.equal(first.length, 33);
  assert.deepEqual((await readdir(root)).sort(), ["dist", "src"]);
  await contribution(root, "src/capabilities/beta/tools.ts", "export default () => {};\n");
  await contribution(root, "src/capabilities/beta/translations.ts", "export default { namespace: 'beta', messages: { hello: { en: 'Hello', 'zh-CN': '你好' } } };\n");
  generateCapabilityCatalogs(root);
  const catalog = join(root, "dist/generated/capabilities/tools.ts");
  assert.match(await readFile(catalog, "utf8"), /alpha\/tools\.js[\s\S]*beta\/tools\.js/);
  await rm(join(root, "src/capabilities/alpha"), { recursive: true });
  generateCapabilityCatalogs(root);
  assert.doesNotMatch(await readFile(catalog, "utf8"), /alpha/);
  assert.match(await readFile(catalog, "utf8"), /beta\/tools\.js/);
  const translations = join(root, "dist/generated/capabilities/translations.ts");
  assert.match(await readFile(translations, "utf8"), /beta\/translations\.js/);
  await rm(join(root, "src/capabilities/beta"), { recursive: true });
  generateCapabilityCatalogs(root);
  assert.doesNotMatch(await readFile(translations, "utf8"), /beta/);
});

test("build catalogs use static browser imports and register a new Tool and Renderer without changing host code", async t => {
  const root = await fixture(t);
  await put(root, "package.json", '{"type":"module"}');
  await put(root, "src/background/main.ts", 'import contributions from "#capabilities/tools"; const names = []; for (const { setup } of contributions) setup({ registerTool: tool => names.push(tool.name) }); export { names };');
  await put(root, "src/sidepanel/main.ts", 'import contributions from "#capabilities/renderers"; const names = []; for (const register of contributions) register({ registerRenderer: renderer => names.push(renderer.id) }); export { names };');
  const initialHost = await tree(join(root, "src"));
  for (const [revision, expected] of [["first", ["alpha"]], ["second", ["alpha", "beta"]], ["third", ["beta"]]]) {
    if (revision === "third") await rm(join(root, "src/capabilities/alpha"), { recursive: true });
    else {
      const name = expected.at(-1);
      await contribution(root, `src/capabilities/${name}/tools.ts`, `export default ({ registerTool }) => { registerTool({ name: ${JSON.stringify(name)} }); };`);
      await contribution(root, `src/capabilities/${name}/renderers.ts`, `export default ({ registerRenderer }) => { registerRenderer({ id: ${JSON.stringify(name)} }); };`);
    }
    const sourceDir = join(root, "src");
    const outputDir = join(root, "dist", revision);
    const profile = capabilityBuildProfile(sourceDir);
    const capabilityEntries = Object.values(discoverCapabilities(sourceDir)).flat().map(path => relative(sourceDir, path));
    const entryPoints = Object.fromEntries(["background/main.ts", "sidepanel/main.ts", ...profile.paths, ...capabilityEntries]
      .map(path => [path.replace(/\.ts$/, ""), join(sourceDir, path)]));
    await build({ absWorkingDir: sourceDir, entryPoints, outdir: outputDir, bundle: true, splitting: true, format: "esm", platform: "browser", plugins: [profile.plugin, {
      name: "application-module-boundaries", setup(context) {
        context.onResolve({ filter: /^\./ }, args => args.importer ? { path: args.path, external: true } : undefined);
      },
    }] });
    for (const [path, contents] of await tree(outputDir)) {
      if (path.endsWith(".js")) assert.doesNotMatch(contents, /#capabilities\/|import\s*\(/, path);
    }
    for (const context of ["background", "sidepanel"]) {
      assert.deepEqual((await import(pathToFileURL(join(outputDir, `${context}/main.js`)))).names, expected);
    }
  }
  for (const [path, contents] of initialHost) assert.equal(await readFile(join(root, "src", path), "utf8"), contents);
  assert.equal((await readdir(join(root, "src"))).includes("capability-catalogs"), false);
});

test("the typecheck command checks a capability's default export against its discovered channel", async t => {
  const root = await fixture(t);
  for (const script of ["typecheck.mjs", "capability-catalog.mjs", "extension-boundaries.mjs", "models-dev-assets.mjs"]) {
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(ROOT, "scripts", script), join(root, "scripts", script));
  }
  await mkdir(join(root, "src/shared/models"), { recursive: true });
  await cp(join(ROOT, "src/shared/models/models-dev-providers.ts"), join(root, "src/shared/models/models-dev-providers.ts"));
  await cp(join(ROOT, "config"), join(root, "config"), { recursive: true });
  await cp(join(ROOT, "tsconfig.json"), join(root, "tsconfig.json"));
  await symlink(join(ROOT, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await put(root, "package.json", JSON.stringify({ type: "module", imports: { "#capabilities/*": "./dist/generated/capabilities/*.ts" } }));
  await put(root, "src/shared/vendor-apis.d.ts", "export {};\n");
  await put(root, "src/sdk/background.ts", "export type ToolExtension = (host: { registerTool(name: string): void }) => void;\n");
  await put(root, "src/background/main.ts", 'import contributions from "#capabilities/tools"; export { contributions };\n');
  const compile = () => {
    // The CLI starts another compiler process and competes with coverage/browser builds in verify.
    const timeout = 60_000;
    const result = spawnSync(process.execPath, [join(root, "scripts/typecheck.mjs")], { cwd: root, encoding: "utf8", timeout });
    assert.ok(!result.error && !result.signal && typeof result.status === "number",
      `Typecheck process did not complete (budget=${timeout}ms, error=${result.error?.message || "none"}, signal=${result.signal || "none"}, status=${result.status}).\n${result.stdout || ""}${result.stderr || ""}`);
    return result;
  };
  for (const [source, diagnostic] of [
    ["export default 42;", /not assignable/],
    ["export const register = () => {};", /no default export/],
  ]) {
    await contribution(root, "src/capabilities/parallel/tools.ts", source);
    const rejected = compile();
    assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout + rejected.stderr, diagnostic);
  }
  await contribution(root, "src/capabilities/parallel/tools.ts", 'export default (host: { registerTool(name: string): void }) => { host.registerTool("parallel"); };');
  const accepted = compile();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);

  for (const path of ["src/sdk/shared/i18n-definition.ts", "src/shared/i18n/definition.ts"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(ROOT, path), join(root, path));
  }
  await contribution(root, "src/capabilities/languages/locales.ts", 'export default [{ language: "ja" }];');
  const invalidLanguage = compile();
  assert.notEqual(invalidLanguage.status, 0);
  assert.match(invalidLanguage.stdout + invalidLanguage.stderr, /locales.ts.*not assignable/);
  await contribution(root, "src/capabilities/languages/locales.ts", 'export default [{ language: "ja", chromeLocale: "ja", name: "日本語" }];');
  const validLanguage = compile();
  assert.equal(validLanguage.status, 0, validLanguage.stdout + validLanguage.stderr);

  await put(root, "src/sdk/sidepanel.ts", "export type UiExtension = () => void;\n");
  await put(root, "src/capabilities/parallel/view.ts", 'import "./value.js"; export default () => document.createElement("section");');
  await put(root, "src/capabilities/parallel/value.ts", 'export const element = document.createElement("span");');
  await put(root, "src/capabilities/parallel/index.ts", "export { default as tools } from './tools.js'; export { default as ui } from './view.js';");
  const domOnly = compile();
  assert.equal(domOnly.status, 0, domOnly.stdout + domOnly.stderr);
  await put(root, "src/capabilities/parallel/tools.ts", 'import "./value.js"; export default () => {};');
  const sharedByBoth = compile();
  assert.notEqual(sharedByBoth.status, 0);
  assert.match(sharedByBoth.stdout + sharedByBoth.stderr, /value.ts.*Cannot find name 'document'/, "the helper must also be checked under the Background environment");
  await put(root, "src/capabilities/parallel/value.ts", "export const value = 1;");
  await put(root, "tests/fixtures/capabilities/example/index.ts", "export { default as tools } from './tool.js'; export { default as ui } from './view.js';");
  await put(root, "tests/fixtures/capabilities/example/tool.ts", "export default 42;");
  await put(root, "tests/fixtures/capabilities/example/view.ts", "export default () => {};");
  const invalidExample = compile();
  assert.notEqual(invalidExample.status, 0);
  assert.match(invalidExample.stdout + invalidExample.stderr, /examples\/tools.ts.*not assignable/, "copyable examples use the same typed channel catalog");
  assert.match(await readFile(join(root, "dist/generated/capabilities/examples/ui.ts"), "utf8"), /id: "example"/);
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qingzhou capability ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function contribution(root, path, content) {
  await put(root, path, content);
  const packagePath = path.match(/^(src\/capabilities\/[^/]+)\//)[1];
  const channel = basename(path, ".ts").replace("model-capabilities", "modelCapabilities").replace("skill-hosts", "skillHosts");
  const index = join(root, packagePath, "index.ts");
  const previous = await readFile(index, "utf8").catch(() => "");
  if (!previous.includes(` as ${channel} }`)) {
    await put(root, `${packagePath}/index.ts`, previous + `export { default as ${channel} } from './${relative(packagePath, path).replace(/\.ts$/, ".js")}';\n`);
  }
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function tree(root, base = root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await tree(path, base));
    else files.push([relative(base, path), await readFile(path, "utf8")]);
  }
  return files;
}

test("UI resources assemble deterministically into static HTML and the exportable skin", async t => {
  const root = await fixture(t);
  await put(root, "src/sidepanel/sidepanel.html", "<main><!-- capability-ui --></main>");
  await put(root, "src/sidepanel/sidepanel.css", ".core { color: red; }");
  for (const name of ["zebra", "alpha"]) {
    await contribution(root, `src/capabilities/${name}/ui.ts`, "export default {};\n");
    await put(root, `src/capabilities/${name}/ui.html`, `<section id="${name}"></section>`);
    await put(root, `src/capabilities/${name}/ui.css`, `.${name} { background-image: url('./icon.svg'); }`);
  }
  const source = join(root, "src");
  const first = await capabilityUiAssets(source);
  assert.deepEqual(await capabilityUiAssets(source), first);
  const html = first.overrides.get(join(source, "sidepanel/sidepanel.html"));
  assert.match(html, /id="alpha"[\s\S]*id="zebra"/);
  assert.doesNotMatch(html, /capability-ui/);
  const css = first.overrides.get(join(source, "sidepanel/sidepanel.css"));
  assert.match(css, /\.core[\s\S]*\.alpha[\s\S]*\.zebra/);
  assert.match(css, /\.\.\/capabilities\/alpha\/icon\.svg/);
  assert.equal(first.resources.size, 4);
  await put(root, "src/sidepanel/sidepanel.html", "<main></main>");
  await assert.rejects(capabilityUiAssets(source), /exactly one/);
});

test("a Renderer-only package contributes its stylesheet without an empty UI factory", async t => {
  const root = await fixture(t);
  await put(root, "src/sidepanel/sidepanel.css", ".core { color: red; }");
  await contribution(root, "src/capabilities/cards/renderers.ts", "export default () => ({ renderers: [] });\n");
  await put(root, "src/capabilities/cards/ui.css", ".card { color: blue; }");
  const source = join(root, "src");
  const first = await capabilityUiAssets(source);
  assert.equal(discoverCapabilities(source).ui.length, 0);
  assert.match(first.overrides.get(join(source, "sidepanel/sidepanel.css")), /\.core[\s\S]*\.card/);
  await contribution(root, "src/capabilities/cards/ui.ts", "export default {};\n");
  assert.deepEqual(await capabilityUiAssets(source), first, "both entrypoints consume a shared resource only once");
});


test("package stylesheet declarations are hoisted ahead of the skin without hardcoded dependency names", async t => {
  const root = await fixture(t);
  await put(root, "src/sidepanel/sidepanel.html", '<head><link id="qingzhou-sidepanel-skin" rel="stylesheet" href="sidepanel.css"></head><body><!-- capability-ui --></body>');
  await contribution(root, "src/capabilities/new-ui/ui.ts", "export default {};\n");
  await put(root, "src/capabilities/new-ui/ui.html", '<!-- <link rel="stylesheet" href="ignored.css"> --><link rel="stylesheet" href="./dependency.css"><section>Page</section>');
  const result = await capabilityUiAssets(join(root, "src"));
  const html = result.overrides.get(join(root, "src/sidepanel/sidepanel.html"));
  assert.match(html, /<head><link rel="stylesheet" href="\.\.\/capabilities\/new-ui\/dependency.css">[\s\S]*id="qingzhou-sidepanel-skin"/);
  assert.match(html, /<body><!-- <link rel="stylesheet" href="ignored.css"> --><section>Page<\/section><\/body>/);
  await rm(join(root, "src/capabilities/new-ui"), { recursive: true });
  assert.equal((await capabilityUiAssets(join(root, "src"))).overrides.size, 0);
});

test("package HTML rebases its own assets while preserving raw text, anchors and external URLs", async t => {
  const root = await fixture(t);
  await put(root, "src/sidepanel/sidepanel.html", '<head><link id="qingzhou-sidepanel-skin" href="sidepanel.css"></head><!-- capability-ui -->');
  await contribution(root, "src/capabilities/photos/ui.ts", "export default {};\n");
  await put(root, "src/capabilities/photos/ui.html", `
    <link rel=stylesheet href='./theme.css'>
    <template><a href='./files/note.html?next=/../target&amp;size=2#section'><img src=./icon.svg srcset="./icon.svg, ./retina.svg 2x, data:image/png;base64,AAAA 3x"></a></template>
    <video poster=" ./poster.svg " src="./movie.mp4"></video>
    <a href="#same-page">Anchor</a><a href="https://example.test/file">Remote</a><img src="/root.svg">
    <!-- <img src="./comment.svg"> -->
    <script>const text = '<img src="./literal.svg">';</script>
    <style>.demo { content: '<a href="./literal.html">'; }</style>
    <textarea><img src="./literal.svg"></textarea>
  `);
  const html = (await capabilityUiAssets(join(root, "src"))).overrides.get(join(root, "src/sidepanel/sidepanel.html"));
  assert.match(html, /<head><link rel=stylesheet href="\.\.\/capabilities\/photos\/theme.css">/);
  assert.match(html, /href="\.\.\/capabilities\/photos\/files\/note.html\?next=\/\.\.\/target&amp;size=2#section"/);
  assert.match(html, /src="\.\.\/capabilities\/photos\/icon.svg"/);
  assert.match(html, /srcset="\.\.\/capabilities\/photos\/icon.svg, \.\.\/capabilities\/photos\/retina.svg 2x, data:image\/png;base64,AAAA 3x"/);
  assert.match(html, /poster=" \.\.\/capabilities\/photos\/poster.svg " src="\.\.\/capabilities\/photos\/movie.mp4"/);
  for (const unchanged of ['href="#same-page"', 'href="https://example.test/file"', 'src="/root.svg"',
    '<!-- <img src="./comment.svg"> -->', '<textarea><img src="./literal.svg"></textarea>',
    `const text = '<img src="./literal.svg">';`, `.demo { content: '<a href="./literal.html">'; }`]) {
    assert.ok(html.includes(unchanged), unchanged);
  }
});

test("UI identity follows the owning package even when internal folders repeat capabilities", async t => {
  const root = await fixture(t);
  await contribution(root, "src/capabilities/outer/views/capabilities/inner/ui.ts", "export default () => {};\n");
  generateCapabilityCatalogs(root);
  const catalog = await readFile(join(root, "dist/generated/capabilities/ui.ts"), "utf8");
  assert.match(catalog, /id: "outer"/);
  assert.doesNotMatch(catalog, /id: "inner"/);
});

test('a package with only embedded Skills is discovered, loaded, and removed without tools or UI', async t => {
  const root = await fixture(t);
  await put(root, 'package.json', '{"type":"module"}');
  await put(root, 'src/shared/main.ts', 'import extensions from "#capabilities/skills"; const skills = []; for (const register of extensions) register({registerSkill: skill => skills.push(skill)}); export {skills};');
  await contribution(root, 'src/capabilities/guide/skills.ts', 'export default qz => qz.registerSkill({name:"independent-guide",description:"A guide",content:"# Guide"});');
  for (const revision of ['present','removed']) {
    if (revision === 'removed') await rm(join(root,'src/capabilities/guide'), {recursive:true});
    const source = join(root,'src');
    const profile = capabilityBuildProfile(source);
    const entries = discoverCapabilities(source);
    assert.equal(entries.tools.length,0);
    assert.equal(entries.ui.length,0);
    assert.equal(entries.skills.length, revision === 'present' ? 1 : 0);
    const output = join(root,'dist',revision);
    const files = ['shared/main.ts',...profile.paths,...Object.values(entries).flat().map(path=>relative(source,path))];
    await build({absWorkingDir:source,entryPoints:Object.fromEntries(files.map(path=>[path.replace(/\.ts$/,''),join(source,path)])),
      outdir:output,bundle:true,splitting:true,format:'esm',platform:'browser',plugins:[profile.plugin,{
        name:'static-modules',setup(context){context.onResolve({filter:/^\./},args=>args.importer?{path:args.path,external:true}:undefined);},
      }]});
    const {skills} = await import(pathToFileURL(join(output,'shared/main.js')));
    assert.deepEqual(skills, revision === 'present' ? [{name:'independent-guide',description:'A guide',content:'# Guide'}] : []);
    assert.equal((await tree(output)).some(([path])=>path.endsWith('/index.js')),false);
  }
});
