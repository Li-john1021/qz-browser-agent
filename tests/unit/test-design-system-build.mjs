import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { capabilityUiAssets } from "../../scripts/capability-catalog.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the compiled skin discovers enabled UI and Renderer sources and preserves ordinary CSS", async t => {
  const source = await fixture(t);
  await put(source, "capabilities/example/index.ts", 'export { default as ui } from "./view.js";\nexport { default as tools } from "./tools.js";');
  await put(source, "capabilities/example/view.ts", 'import { label } from "./shared.js"; export default () => `qz:grid ${label}`;');
  await put(source, "capabilities/example/shared.ts", 'export const label = "qz:gap-5";');
  await put(source, "capabilities/example/tools.ts", 'import { label } from "./shared.js"; export default () => `qz:top-[713px] ${label}`;');
  await put(source, "capabilities/example/ui.html", '<section class="qz:text-foreground qz:p-4"></section>');
  await put(source, "capabilities/example/ui.css", '.applied { @apply qz:block qz:mt-3 qz:text-secondary; background-image: url("./icon.svg"); }');
  await put(source, "capabilities/example/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put(source, "capabilities/cards/index.ts", 'export { default as renderers } from "./render.js";');
  await put(source, "capabilities/cards/render.ts", 'export default () => "qz:w-[173px]";');
  await put(source, "capabilities/backend/index.ts", 'export { default as tools } from "./tools.js";');
  await put(source, "capabilities/backend/tools.ts", 'export default () => "qz:top-[719px]";');
  await put(source, "capabilities/backend/ui.html", '<aside class="qz:top-[727px]"></aside>');
  await put(source, "ignored.html", '<aside class="qz:top-[733px]"></aside>');

  const before = await readFile(join(source, "sidepanel/sidepanel.css"), "utf8");
  const first = await skin(source);
  assert.match(first, /@layer theme, base, vendor, components, utilities;/u,
    "the authored design system defines one stable cascade order");
  assert.match(first, /@layer utilities\s*\{/u, "generated utilities participate in the public override layer");
  assert.equal(await skin(source), first, "a repeated compilation is byte-identical");
  assert.equal(await readFile(join(source, "sidepanel/sidepanel.css"), "utf8"), before, "compilation never rewrites the authored skin");
  for (const rule of [
    /\.qz\\:grid\s*\{\s*display:\s*grid;/u,
    /\.qz\\:gap-5\s*\{\s*gap:\s*calc\(var\(--control-gap-xs\)\s*\*\s*5\);/u,
    /\.qz\\:p-4\s*\{\s*padding:\s*calc\(var\(--control-gap-xs\)\s*\*\s*4\);/u,
    /width:\s*173px;/u,
    /\.applied\s*\{[^}]*display:\s*block;[^}]*color:\s*var\(--text-secondary\);/u,
  ]) assert.match(first, rule);
  assert.match(first, /\.applied\s*\{[^}]*margin-top:\s*calc\(var\(--control-gap-xs\)\s*\*\s*3\);/u);
  assert.match(first, /\.\.\/capabilities\/example\/icon\.svg/u, "package-relative URLs retain their asset owner");
  assert.match(first, /\.preserved\s*\{[^}]*border:\s*0 solid;[^}]*line-height:\s*normal;/u, "ordinary declarations survive without a reset or optimizer rewrite");
  assert.match(first, /\.qz-field\b/u, "public controls remain in the same skin");
  assert.match(first, /prefers-color-scheme:\s*dark/u, "dark token overrides remain in the same skin");
  assert.doesNotMatch(first, /(?:713|719|727|733)px/u, "background-only and unrelated files never contribute utility candidates");
  assert.doesNotMatch(first, /@(?:theme|source|apply|tailwind|import)\b/u, "the browser receives static CSS only");
  assert.doesNotMatch(first, /::file-selector-button[\s\S]{0,150}box-sizing/u, "Tailwind Preflight must not be emitted");
});

test("rebuilding after a class or capability removal drops its generated utilities and CSS", async t => {
  const source = await fixture(t);
  await put(source, "capabilities/cards/index.ts", 'export { default as renderers } from "./render.js";');
  await put(source, "capabilities/cards/render.ts", 'export default () => "qz:w-[181px]";');
  await put(source, "capabilities/cards/ui.css", '.owned-card { @apply qz:text-secondary; }');
  assert.match(await skin(source), /width:\s*181px;/u);
  await put(source, "capabilities/cards/render.ts", 'export default () => "qz:w-[193px]";');
  const updated = await skin(source);
  assert.match(updated, /width:\s*193px;/u);
  assert.doesNotMatch(updated, /181px/u, "removed candidates do not linger across rebuilds");
  await put(source, "capabilities/cards/ui.css", ".owned-card { @apply qz:p-5; }");
  const restyled = await skin(source);
  assert.match(restyled, /\.owned-card\s*\{\s*padding:\s*calc\(var\(--control-gap-xs\)\s*\*\s*5\);/u);
  assert.doesNotMatch(restyled, /\.owned-card\s*\{[^}]*color:/u, "edited package CSS replaces its previous compiled declarations");
  await rm(join(source, "capabilities/cards"), { recursive: true });
  const removed = await skin(source);
  assert.doesNotMatch(removed, /193px|owned-card/u, "removing a package removes its entire style contribution");
  assert.match(removed, /\.qz-field\b/u, "a skin without optional packages still compiles its shared design system");
});

test("invalid capability utilities fail the build with a useful diagnostic", async t => {
  const source = await fixture(t);
  await put(source, "capabilities/broken/index.ts", 'export { default as renderers } from "./render.js";');
  await put(source, "capabilities/broken/render.ts", "export default () => {};\n");
  await put(source, "capabilities/broken/ui.css", ".broken { @apply qz:not-a-real-utility; }");
  await assert.rejects(skin(source), /(?:unknown utility|not-a-real-utility)/iu);
});

test("the selected theme compiles without a default directory and tracks its own resources", async t => {
  const source = await fixture(t);
  await rename(join(source, "themes/default"), join(source, "themes/custom"));
  await put(source, "themes/custom/overrides.css", '@layer theme { :root { --accent: teal; } }');
  const entry = join(source, "themes/custom/index.css");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n@import "./overrides.css";\n`);
  await put(source, "sidepanel/sidepanel.css", '@import "../themes/custom/index.css";');
  await put(source, "capabilities/cards/index.ts", 'export { default as renderers } from "./render.js";');
  await put(source, "capabilities/cards/render.ts", 'export default () => "qz:w-[193px]";');
  await put(source, "capabilities/cards/ui.css", '.themed-card { @apply qz:text-foreground; }');
  const { overrides, resources } = await capabilityUiAssets(source);
  const css = overrides.get(join(source, "sidepanel/sidepanel.css"));
  assert.match(css, /--accent:\s*teal;/u);
  assert.match(css, /width:\s*193px;/u);
  assert.match(css, /\.themed-card\s*\{\s*color:\s*var\(--text-primary\);/u);
  assert.match(css, /\.qz-field\b/u);
  assert.doesNotMatch(css, /@(?:import|theme|tailwind|apply)\b/u);
  assert.ok(resources.has(join(source, "themes/custom/overrides.css")), "custom imports participate in build dependency tracking");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-design-system-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "src");
  await cp(join(ROOT, "src/themes/default"), join(source, "themes/default"), { recursive: true });
  await put(source, "sidepanel/sidepanel.css", '@import "../themes/default/index.css";\n.preserved { border: 0 solid; line-height: normal; }');
  await put(source, "sidepanel/sidepanel.html", '<head><link id="qingzhou-sidepanel-skin" href="sidepanel.css"></head><body><!-- capability-ui --></body>');
  return source;
}

async function skin(source) {
  const result = await capabilityUiAssets(source);
  const stylesheet = result.overrides.get(join(source, "sidepanel/sidepanel.css"));
  assert.equal(typeof stylesheet, "string", "the active skin is always compiled, including an empty capability set");
  return stylesheet;
}

async function put(root, path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}
