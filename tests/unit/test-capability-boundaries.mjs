import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { generateCapabilityCatalogs } from "../../scripts/capability-catalog.mjs";
import { validateExtensionBoundaries } from "../../scripts/extension-boundaries.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
generateCapabilityCatalogs(ROOT);
const graph = validateExtensionBoundaries(resolve(ROOT, "src"));
const contexts = Object.fromEntries(Object.entries(graph.contexts).map(([context, files]) => [context,
  new Set([...files].map(file => relative(ROOT, file).split(sep).join("/"))),
]));
const background = path => /(?:^src\/background\/|^src\/products\/[^/]+\/background\/)/.test(path)
  || (contexts.background.has(path) && !contexts.shared.has(path) && !contexts.sidepanel.has(path));
const sidepanel = path => /(?:^src\/sidepanel\/|^src\/products\/[^/]+\/sidepanel\/)/.test(path)
  || (contexts.sidepanel.has(path) && !contexts.shared.has(path) && !contexts.background.has(path));
const documentRuntime = /(?:\/document-(?:utils|codecs)\.ts$|\/node_modules\/pdfjs-dist\/)/;
const documentEngines = /(?:\/document-(?:utils|codecs)\.ts$|\/node_modules\/(?:pdfjs-dist|xlsx)\/)/;

async function runtimeGraph(entryPoints) {
  // Resolve actual imports, including discovered catalogs; type-only edges disappear naturally.
  const result = await build({
    absWorkingDir: ROOT, entryPoints, bundle: true, write: false, metafile: true,
    outdir: resolve(ROOT, "tests/results/capability-boundaries"),
    platform: "browser", format: "esm", target: "chrome114", logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map(path => relative(ROOT, resolve(ROOT, path)).split(sep).join("/"));
}

test("the Side Panel capability graph cannot load Background implementations or document codecs/PDF", async () => {
  const paths = await runtimeGraph(["src/sidepanel/sidepanel.ts"]);
  assert.ok(paths.some(path => graph.entries.renderers.includes(resolve(ROOT, path))), "the graph must cover registered renderers");
  assert.deepEqual(paths.filter(path => background(path) || documentRuntime.test(`/${path}`)), []);
});

test("shared capability modules stay independent of both host implementation contexts", async () => {
  const entries = [...graph.contexts.shared];
  assert.ok(entries.length > 0);
  const paths = await runtimeGraph(entries);
  assert.deepEqual(paths.filter(path => background(path) || sidepanel(path)), []);
});

test("tool identity and document format metadata remain light even when codecs have heavy implementations", async () => {
  const paths = await runtimeGraph(["src/shared/tools/tool-metadata.ts", "src/shared/documents/document-create-input.ts"]);
  assert.ok(paths.some(path => graph.entries.metadata.includes(resolve(ROOT, path))), "metadata must include discovered declarations");
  assert.deepEqual(paths.filter(path => background(path) || sidepanel(path) || documentEngines.test(`/${path}`)), []);
});

test("shared rendering primitives and optional UI registration do not load other capability implementations", async () => {
  const entries = globSync("src/sidepanel/tools/primitives/*.ts", { cwd: ROOT });
  const paths = await runtimeGraph([...entries, "src/capabilities/ui/renderers.ts"]);
  assert.deepEqual(paths.filter(path => /^src\/capabilities\/(?!ui\/)/.test(path) && !contexts.shared.has(path)), []);
});


test("framework imports capabilities only through file-discovered channel contracts", () => {
  const violations = [];
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({ openProjects: ["background", "dom", "worker"].map(name => resolve(ROOT, `config/typescript/${name}.json`)) });
  try {
    for (const file of globSync("src/**/*.ts", { cwd: ROOT })) {
      if (file.startsWith("src/capabilities/") || file.startsWith("src/products/")) continue;
      const ast = snapshot.getProjects().map(project => project.program.getSourceFile(resolve(ROOT, file))).find(Boolean);
      assert.ok(ast, `framework source must belong to a checked TypeScript context: ${file}`);
      for (const node of ast.statements) {
        if (![SyntaxKind.ImportDeclaration, SyntaxKind.ExportDeclaration].includes(node.kind)) continue;
        const specifier = node.moduleSpecifier?.text;
        if (!specifier?.startsWith(".")) continue;
        const target = relative(ROOT, resolve(dirname(resolve(ROOT, file)), specifier)).split(sep).join("/");
        if (target.startsWith("src/capabilities/")) violations.push(`${file} → ${specifier}`);
      }
    }
    assert.deepEqual(violations, [], "core must not require a concrete optional package, including type-only imports");
  } finally { snapshot.dispose(); api.close(); }
});
