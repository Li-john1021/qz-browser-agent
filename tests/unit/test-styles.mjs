import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse, walk } from "css-tree";
import { compileStylesheet } from "../../scripts/styles.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qz-styles-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  };
  const entry = await put("panel/main.css", '@import "../theme/index.css";');
  return { root, put, compile: () => compileStylesheet({ sourceDir: root, entry }) };
}

function urls(css) {
  const values = [];
  walk(parse(css, { parseCustomProperty: true }), function (node) {
    if (node.type === "Url" || (node.type === "String" && /image-set/.test(this.function?.name || ""))) values.push(node.value);
  });
  return values;
}

test("styles preserve layered imports, package style exports and imported utility resources", async t => {
  const { root, put, compile } = await fixture(t);
  await put("node_modules/css-fixture/package.json", JSON.stringify({ exports: { ".": { style: "./theme.css" } } }));
  const packageCss = await put("node_modules/css-fixture/theme.css", '.package { background: url("./badge.svg"); }');
  await put("theme/index.css", `
    @layer theme, components, utilities;
    @import "css-fixture" layer(components);
    @import "tailwindcss/utilities.css" layer(utilities) prefix(qz) source(none);
    @import "./nested/card.css";
    @theme inline prefix(qz) { --color-fixture: red; }
    .card { @apply qz:card; }
  `);
  const cardCss = await put("theme/nested/card.css", `
    @utility card {
      background: url("./card.svg");
      @variant hover { background: url("./hover.svg"); }
    }
  `);
  const result = await compile();
  assert.match(result.css, /@layer theme, components, utilities;/);
  assert.deepEqual(urls(result.css), ["../node_modules/css-fixture/badge.svg", "../theme/nested/card.svg", "../theme/nested/hover.svg"]);
  for (const file of [join(root, "theme/index.css"), cardCss, packageCss]) assert.ok(result.dependencies.has(file), file);
});

test("styles rebase escaped URLs, image sets and custom properties while preserving external resources and text", async t => {
  const { put, compile } = await fixture(t);
  await put("theme/index.css", '@import "./nested/resources.css";');
  await put("theme/nested/resources.css", String.raw`
    @font-face { font-family: Fixture; src: url("./font.woff2?v=1#font"); }
    .resources {
      --icon: url(./icon\ space.svg);
      background-image: image-set("./one.png" 1x, url("./two.png") 2x);
      border-image-source: url("./image(1).svg?x=/a#id");
      mask-image: url(./ic\6f n.svg);
      content: "url(./unchanged.png)";
    }
    .remote { background: url("https://example.test/image.svg"); }
    .protocol { background: url("//example.test/image.svg"); }
    .absolute { background: url("/assets/image.svg"); }
    .fragment { filter: url("#filter"); }
    .data { background: url("data:image/svg+xml,%3Csvg/%3E"); }
    .blob { background: url("blob:https://example.test/id"); }
  `);
  const { css } = await compile();
  assert.deepEqual(urls(css), [
    "../theme/nested/font.woff2?v=1#font", "../theme/nested/icon space.svg",
    "../theme/nested/one.png", "../theme/nested/two.png", "../theme/nested/image(1).svg?x=/a#id",
    "../theme/nested/icon.svg", "https://example.test/image.svg", "//example.test/image.svg",
    "/assets/image.svg", "#filter", "data:image/svg+xml,%3Csvg/%3E", "blob:https://example.test/id",
  ]);
  assert.match(css, /content: "url\(\.\/unchanged\.png\)"/);
});

test("a missing nested import fails and subsequent builds read repaired and changed stylesheets", async t => {
  const { put, compile } = await fixture(t);
  await put("theme/index.css", '@import "./missing.css";');
  await assert.rejects(compile(), /missing\.css/);
  const dependency = await put("theme/missing.css", ".recovered { color: red; }");
  const first = await compile();
  assert.ok(first.dependencies.has(dependency));
  assert.match(first.css, /color: red/);
  await put("theme/missing.css", ".recovered { color: blue; }");
  assert.match((await compile()).css, /color: blue/);
});
