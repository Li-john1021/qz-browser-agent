import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";

export const CAPABILITY_CONTEXTS = Object.freeze({
  tools: "background", ui: "sidepanel", renderers: "sidepanel", presets: "background",
  providers: "background", context: "background", observers: "background", metadata: "shared",
  modelCapabilities: "shared", artifacts: "shared", codecs: "shared", skills: "shared", skillHosts: "background", translations: "shared", locales: "shared",
});
const syntaxCache = new Map();
const posix = value => value.split(sep).join("/");
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);

/** Type-only edges count too: transpilation must not erase a boundary violation. */
function moduleEdges(files, sourceDir) {
  const contents = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
  const changed = files.filter(file => syntaxCache.get(file)?.text !== contents.get(file));
  if (!changed.length) return;
  const api = new API({ cwd: sourceDir });
  const snapshot = api.updateSnapshot({ openFiles: changed });
  try {
    for (const file of changed) {
      const ast = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (!ast) throw new Error(`Cannot inspect extension source: ${file}`);
      const edges = [];
      const add = node => {
        const literal = node?.kind === SyntaxKind.LiteralType ? node.literal : node;
        edges.push(typeof literal?.text === "string" && [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(literal.kind)
          ? literal.text : null);
      };
      const visit = node => {
        if ([SyntaxKind.ImportDeclaration, SyntaxKind.ExportDeclaration].includes(node.kind) && node.moduleSpecifier) add(node.moduleSpecifier);
        if (node.kind === SyntaxKind.ImportType) add(node.argument);
        if (node.kind === SyntaxKind.ExternalModuleReference) add(node.expression);
        if (node.kind === SyntaxKind.CallExpression && (node.expression.kind === SyntaxKind.ImportKeyword
          || (node.expression.kind === SyntaxKind.Identifier && node.expression.text === "require"))) add(node.arguments[0]);
        node.forEachChild(visit);
      };
      visit(ast);
      for (const reference of ast.referencedFiles || []) edges.push(reference.fileName);
      syntaxCache.set(file, { text: contents.get(file), edges });
    }
  } finally { snapshot.dispose(); api.close(); }
}

/** index.ts is a declaration, never a runtime module mixing Chrome contexts. */
function entryDeclarations(index) {
  let statements;
  try { statements = parse(readFileSync(index, "utf8"), { ecmaVersion: "latest", sourceType: "module" }).body; }
  catch (error) { throw new Error(`Invalid capability index ${index}: ${error.message}`); }
  const entries = new Map();
  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.source || !statement.specifiers.length || statement.attributes?.length
      || statement.specifiers.some(specifier => specifier.type !== "ExportSpecifier" || specifier.local.name !== "default")) {
      throw new Error(`Invalid capability index ${index}: use only export { default as <channel> } from './file.js'`);
    }
    for (const specifier of statement.specifiers) {
      const channel = specifier.exported.name;
      if (!Object.hasOwn(CAPABILITY_CONTEXTS, channel)) throw new Error(`Unknown capability channel ${channel} in ${index}`);
      if (entries.has(channel)) throw new Error(`Duplicate capability channel ${channel} in ${index}`);
      entries.set(channel, statement.source.value);
    }
  }
  if (!entries.size) throw new Error(`Capability index declares no contributions: ${index}`);
  return entries;
}

/** Discover and check each source in every context that can reach it, independent of its directory. */
export function validateExtensionBoundaries(sourceDir, { directory = resolve(sourceDir, "capabilities") } = {}) {
  sourceDir = existsSync(sourceDir) ? realpathSync(sourceDir) : resolve(sourceDir);
  const entries = Object.fromEntries(Object.keys(CAPABILITY_CONTEXTS).map(channel => [channel, []]));
  const contexts = { background: new Set(), sidepanel: new Set(), shared: new Set() };
  const declarations = new Set();
  const graph = { entries, contexts, declarations };
  const root = lstatSync(directory, { throwIfNoEntry: false });
  if (!root) return graph;
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Invalid capability root: directory symlinks are not allowed");
  directory = realpathSync(directory);
  const packages = [];
  for (const name of readdirSync(directory).sort()) {
    const packageDir = resolve(directory, name);
    const stat = lstatSync(packageDir);
    if (stat.isSymbolicLink()) throw new Error(`Capability symlink is not allowed: ${name}`);
    if (!stat.isDirectory()) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid capability directory: ${name}`);
    const files = [];
    const walk = path => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Capability symlink is not allowed: ${posix(relative(directory, path))}`);
      if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) walk(resolve(path, entry));
      else if (/\.[cm]?[jt]sx?$/.test(path)) {
        if (!/\.ts$/.test(path)) throw new Error(`Capability source must use .ts (JS and TSX are not extension modules): ${path}`);
        files.push(path);
      }
    };
    walk(packageDir);
    const index = resolve(packageDir, "index.ts");
    if (!files.includes(index)) throw new Error(`Capability ${name} requires index.ts with named contribution exports`);
    declarations.add(index);
    packages.push({ name, packageDir, files, index });
  }
  moduleEdges(packages.flatMap(({ files, index }) => files.filter(file => file !== index)), sourceDir);
  for (const { name, packageDir, files, index } of packages) {
    const fail = (file, context, specifier, reason) => {
      throw new Error(`Extension boundary: ${name}/${posix(relative(packageDir, file))} (${context}) → ${specifier ?? "dynamic import"}: ${reason}`);
    };
    const localTarget = (file, context, specifier) => {
      if (!/^\.{1,2}\//.test(specifier)) fail(file, context, specifier, "entry targets must be relative package paths");
      const path = resolve(dirname(file), specifier);
      if (!inside(packageDir, path)) fail(file, context, specifier, "relative imports must stay inside the package");
      if (!specifier.endsWith(".js")) fail(file, context, specifier, "relative module paths must use the emitted .js extension");
      const target = [path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".d.ts")]
        .find(candidate => files.includes(candidate));
      if (!target) fail(file, context, specifier, "missing TypeScript module");
      if (target === index) fail(file, context, specifier, "index.ts is a declaration and cannot be imported at runtime");
      return target;
    };
    const ownEntries = entryDeclarations(index);
    const reached = new Set();
    const visit = (file, context) => {
      if (contexts[context].has(file)) return;
      contexts[context].add(file);
      reached.add(file);
      for (const specifier of syntaxCache.get(file).edges) {
        if (specifier === null) fail(file, context, specifier, "module paths must be static");
        if (specifier.startsWith("#sdk/")) {
          const name = specifier.slice(5), [sdkContext] = name.split("/");
          if (!name || name.split("/").some(part => !part || part === "." || part === "..") || name.includes("\\")) fail(file, context, specifier, "invalid SDK path");
          if (![context, "shared"].includes(sdkContext)) fail(file, context, specifier, "SDK belongs to another runtime context");
          const target = resolve(sourceDir, "sdk", `${name}.ts`);
          const declared = existsSync(target) ? target : target.replace(/\.ts$/, ".d.ts");
          if (!existsSync(declared) || !inside(resolve(sourceDir, "sdk"), realpathSync(declared))) fail(file, context, specifier, "unknown SDK entry");
        } else if (specifier.startsWith(".")) visit(localTarget(file, context, specifier), context);
        else if (!/^(?:@[a-z\d_.-]+\/)?[a-z\d_][a-z\d_.-]*(?:\/[a-z\d_@.+-]+)*$/i.test(specifier)) {
          fail(file, context, specifier, "use a declared SDK entry or an npm package");
        }
      }
    };
    for (const [channel, specifier] of ownEntries) {
      const context = CAPABILITY_CONTEXTS[channel];
      const target = localTarget(index, context, specifier);
      if (target.endsWith(".d.ts")) fail(index, context, specifier, "entry must have a runtime implementation, not a type declaration");
      entries[channel].push(target);
      visit(target, context);
    }
    const orphaned = files.filter(file => file !== index && !reached.has(file));
    if (orphaned.length) throw new Error(`Capability ${name} has TypeScript sources unreachable from index.ts: ${orphaned.map(file => posix(relative(packageDir, file))).join(", ")}`);
  }
  return graph;
}
