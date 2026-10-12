import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { parse } from "acorn";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const roots = [join(root, "src/background"), join(root, "src/shared")];
const files = roots.flatMap(walk).filter(path => [".js", ".mjs", ".ts"].includes(extname(path))).sort();
const fileSet = new Set(files);
const graph = new Map();

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  // Type-only edges do not exist in Chrome; inspect the emitted runtime graph.
  const source = file.endsWith(".ts") ? transformSync(raw, { loader: "ts", target: "esnext", format: "esm" }).code : raw;
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  assertStaticImports(ast, file);
  const imports = ast.body
    .filter(node => ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source)
    .map(node => node.source.value)
    .filter(specifier => specifier.startsWith("."))
    .map(specifier => resolveModule(file, specifier));
  for (const target of imports) {
    assert.ok(existsSync(target), `missing relative module: ${relative(root, file)} -> ${relative(root, target)}`);
  }
  graph.set(file, imports.filter(target => fileSet.has(target)));
}

const visiting = new Set();
const visited = new Set();
const stack = [];
for (const file of files) visit(file);

const agent = read("src/background/agent/agent.ts");
assert.doesNotMatch(agent, /\bchrome\./, "Agent aggregate must not access Chrome APIs directly");
assert.doesNotMatch(agent, /\bgetSessions\b/, "Agent aggregate must not read Session metadata storage");
assert.doesNotMatch(agent, /\bforceReset\s*\(/, "Agent must not expose a hard reset that revokes lifecycle state behind the Supervisor");

const serviceWorker = read("src/background/service-worker.js");
assert.doesNotMatch(
  serviceWorker,
  /chrome\.storage\.local\.(?:get|set|remove|clear)\(/,
  "Service Worker must use Repository/runtime boundaries for storage operations",
);

for (const path of [
  "src/background/transports/mcp.js",
  "src/background/transports/runtime-message.js",
  "src/background/transports/sidepanel.js",
]) {
  const source = read(path);
  assert.doesNotMatch(source, /chrome\.storage|sessionSupervisor|new Agent|setSessionRuntime\(/, `${path} must stay a protocol adapter`);
}

assert.doesNotMatch(
  files.filter(file => file.includes("/src/background/")).map(file => readFileSync(file, "utf8")).join("\n"),
  /setSessionRuntimeController|setToolEventSink|setToolUsageEventSink/,
  "legacy runtime setter injection must not return",
);

console.log(`background import graph tests passed (${files.length} modules, no cycles)`);

function assertStaticImports(node, file) {
  if (!node || typeof node !== "object") return;
  assert.notEqual(node.type, "ImportExpression", `${relative(root, file)}: Background/Shared modules must use static imports; MV3 service workers reject import() even if a production bundle inlines it`);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => assertStaticImports(child, file));
    else if (value && typeof value === "object") assertStaticImports(value, file);
  }
}

function visit(file) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file].map(item => relative(root, item)).join(" -> ");
    assert.fail(`static import cycle: ${cycle}`);
  }
  visiting.add(file);
  stack.push(file);
  for (const target of graph.get(file) || []) visit(target);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

function resolveModule(importer, specifier) {
  const candidate = resolve(dirname(importer), specifier);
  if (extname(candidate)) return resolveSource(candidate);
  for (const suffix of [".js", ".ts", ".mjs", "/index.js", "/index.ts", "/index.mjs"]) {
    if (existsSync(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
  }
  return candidate;
}

function resolveSource(candidate) {
  // Keep emitted .js specifiers for both TS implementations and type-only
  // declaration imports. Runtime resolution is also checked by the build.
  if (existsSync(candidate) || !candidate.endsWith(".js")) return candidate;
  return [".ts", ".d.ts"].map(suffix => candidate.replace(/\.js$/, suffix)).find(existsSync) || candidate;
}

function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function read(path) {
  return readFileSync(resolveSource(join(root, path)), "utf8");
}
