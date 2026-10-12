import fs, { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { compile } from "tailwindcss";
import { Scanner } from "@tailwindcss/oxide";
import enhancedResolve from "enhanced-resolve";
import postcss from "postcss";
import { generate, parse, walk } from "css-tree";

const require = createRequire(import.meta.url);
const posix = value => value.split(sep).join("/");
const externalUrl = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** One compiled skin serves the live panel and static exports; source CSS is never shipped twice. */
export async function compileStylesheet({ sourceDir, entry, stylesheets = [], sources = [] }) {
  const dependencies = new Set([entry, ...stylesheets].map(path => resolve(path)));
  const base = realpathSync(dirname(entry));
  const sourceRoot = realpathSync(sourceDir);
  const resolveCss = enhancedResolve.create.sync({
    fileSystem: fs, extensions: [".css"], mainFields: ["style"], conditionNames: ["style"],
  });
  let css = [entry, ...stylesheets].map(file => `@import ${JSON.stringify(posix(file))};`).join("\n");
  // Resolve the authored theme through imports; compilation never depends on a theme's name or directory.
  const compiler = await compile(css, {
    // Resolver realpaths imports (notably /var → /private/var on macOS); URL roots must agree.
    base, from: entry, polyfills: 0,
    async loadStylesheet(id, importer) {
      const path = id.startsWith("tailwindcss/") ? require.resolve(id) : resolveCss(importer, id);
      if (!path) throw new Error(`Could not resolve '${id}' from '${importer}'`);
      dependencies.add(resolve(sourceDir, relative(sourceRoot, path)));
      return { path, base: dirname(path), content: rebaseUrls(readFileSync(path, "utf8"), dirname(path), base) };
    },
  });
  // Explicit inputs follow the enabled UI graph, not the working directory or stale build output.
  const scanner = new Scanner({ sources: compiler.sources });
  const candidates = scanner.scan();
  candidates.push(...scanner.scanFiles([...new Set(sources)].sort().map(file => ({
    content: readFileSync(file, "utf8"), extension: extname(file).slice(1),
  }))));
  css = compiler.build([...new Set(candidates)].sort());
  const result = await build({
    absWorkingDir: sourceDir, bundle: true, write: false, logLevel: "silent",
    stdin: { contents: css, loader: "css", resolveDir: dirname(entry) },
    plugins: [{ name: "skin-resource-urls", setup(context) {
      context.onLoad({ filter: /\.css$/ }, args => { dependencies.add(args.path); });
      context.onResolve({ filter: /.*/ }, args => {
        if (args.kind !== "url-token") return undefined;
        return { path: externalUrl.test(args.path) ? args.path : posix(relative(dirname(entry), resolve(args.resolveDir, args.path))), external: true };
      });
    } }],
  });
  return { css: result.outputFiles[0].text, dependencies };
}

/** Preserve Tailwind syntax and CSS text; rewrite only parsed resource references. */
function rebaseUrls(css, from, to) {
  const root = postcss.parse(css);
  root.walkDecls(declaration => {
    const edits = [];
    walk(parse(declaration.value, { context: "value", positions: true }), function (node) {
      if (node.type !== "Url" && !(node.type === "String" && /^(?:-webkit-)?image-set$/i.test(this.function?.name || ""))) return;
      if (!node.value || externalUrl.test(node.value)) return;
      const suffix = node.value.search(/[?#]/);
      const path = suffix < 0 ? node.value : node.value.slice(0, suffix);
      const value = posix(relative(to, resolve(from, path))) + (suffix < 0 ? "" : node.value.slice(suffix));
      edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: generate({ ...node, value }) });
    });
    for (const edit of edits.reverse()) {
      declaration.value = declaration.value.slice(0, edit.start) + edit.text + declaration.value.slice(edit.end);
    }
  });
  return root.toString();
}
