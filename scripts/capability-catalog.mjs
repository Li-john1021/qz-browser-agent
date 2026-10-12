import { CAPABILITY_CONTEXTS, validateExtensionBoundaries } from "./extension-boundaries.mjs";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

// One convention serves TypeScript, source tests and MV3 builds. Catalogs contain
// static imports only; the browser never scans files or evaluates registration code.
const channels = Object.freeze({
  translations: ["sdk/shared/i18n-definition.ts", "TranslationCatalog"],
  locales: ["sdk/shared/i18n-definition.ts", "readonly LanguagePack[]"],
  skills: ["sdk/shared/skill-definition.ts", "SkillExtension"],
  skillHosts: ["sdk/background/skill-hosts.ts", "SkillHostExtension"],
  tools: ["sdk/background.ts", "ToolExtension"],
  ui: ["sdk/sidepanel.ts", "UiExtension"],
  renderers: ["sdk/sidepanel.ts", "RendererExtension"],
  presets: ["background/llm/provider-types.ts", "Readonly<Record<string, ProviderPreset>>"],
  providers: ["background/llm/protocol-registry.ts", "Readonly<Record<string, ProviderAdapter>>"],
  context: ["sdk/background/context.ts", "ContextCapability"],
  observers: ["sdk/background/observers.ts", "readonly LifecycleObserver[]"],
  metadata: ["shared/capabilities.ts", "CapabilityMetadata"],
  modelCapabilities: ["shared/contracts/model-capabilities.ts", "ModelCapabilityContribution"],
  artifacts: ["shared/tools/artifact-projection.ts", "Readonly<Record<string, ToolArtifactAdapter>>"],
  codecs: ["shared/documents/document-codec-registry.ts", "readonly DocumentCodec[]"],
});
const posix = value => value.split(sep).join("/");
const modulePath = (from, to) => {
  const path = posix(relative(dirname(from), to)).replace(/\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
};

export function discoverCapabilities(sourceDir) {
  return validateExtensionBoundaries(sourceDir).entries;
}

export function capabilityCatalogSource(channel, entries, sourceDir, destination, packageRoot = resolve(sourceDir, "capabilities")) {
  const [contract, type] = channels[channel] || [];
  if (!contract) throw new Error(`Unknown capability channel: ${channel}`);
  const typeName = type.match(/(?:TranslationCatalog|LanguagePack|SkillHostExtension|SkillExtension|ToolExtension|UiExtension|RendererExtension|ProviderAdapter|ProviderPreset|ContextCapability|LifecycleObserver|CapabilityMetadata|DocumentCodec|ModelCapabilityContribution|ToolArtifactAdapter)/)[0];
  const owned = channel === "ui" || channel === "tools";
  return [
    "// Generated from capabilities/<name>/index.ts. Do not edit.",
    `import type { ${typeName} } from ${JSON.stringify(modulePath(destination, resolve(sourceDir, contract)))};`,
    ...entries.map((entry, index) => `import capability${index} from ${JSON.stringify(modulePath(destination, entry))};`),
    `const contributions: readonly (${owned ? `{ id: string; setup: ${type} }` : type})[] = Object.freeze([${entries.map((entry, index) => owned ? `{ id: ${JSON.stringify(relative(packageRoot, entry).split(sep)[0])}, setup: capability${index} }` : `capability${index}`).join(", ")}]);`,
    "export default contributions;\n",
  ].join("\n");
}

/** Generated artifacts stay in dist; package imports give Node and tsc the same graph. */
export function generateCapabilityCatalogs(rootDir) {
  rootDir = realpathSync(rootDir);
  const source = resolve(rootDir, "src");
  const graph = validateExtensionBoundaries(source);
  const fixtures = validateExtensionBoundaries(source, { directory: resolve(rootDir, "tests/fixtures/capabilities") });
  const generated = resolve(rootDir, "dist/generated/capabilities");
  for (const [group, entries, packageRoot] of [["", graph.entries, resolve(source, "capabilities")],
    ["examples/", fixtures.entries, resolve(rootDir, "tests/fixtures/capabilities")]]) {
    for (const channel of Object.keys(channels)) {
      const destination = resolve(generated, `${group}${channel}.ts`);
      writeGenerated(destination, capabilityCatalogSource(channel, entries[channel], source, destination, packageRoot));
    }
  }
  for (const context of ["background", "sidepanel", "shared"]) {
    const imports = [graph, fixtures].flatMap((item, index) => Object.keys(channels)
      .filter(channel => CAPABILITY_CONTEXTS[channel] === context && item.entries[channel].length)
      .map(channel => `import ${JSON.stringify(`./${index ? "examples/" : ""}${channel}.js`)};`));
    writeGenerated(resolve(generated, `${context}-roots.ts`), ["// Generated typecheck roots; never loaded by the extension.", ...imports, "export {};\n"].join("\n"));
  }
  return graph.entries;
}

function writeGenerated(destination, contents) {
  if (existsSync(destination) && readFileSync(destination, "utf8") === contents) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, destination);
}

/** Virtual entry modules are emitted alongside normal modules, then bundled normally. */
export function capabilityBuildProfile(sourceDir) {
  const { entries, declarations } = validateExtensionBoundaries(sourceDir);
  const paths = Object.keys(channels).map(channel => `capability-catalogs/${channel}.ts`);
  const sources = new Map(paths.map((path, index) => {
    const channel = Object.keys(channels)[index];
    const destination = resolve(sourceDir, path);
    return [destination, capabilityCatalogSource(channel, entries[channel], sourceDir, destination)];
  }));
  const plugin = { name: "capability-catalogs", setup(build) {
    // Content and embedded IIFEs cannot leave imports behind; ESM entries retain module boundaries.
    const reference = (importer, target) => build.initialOptions.format === "iife"
      ? { path: target } : { path: modulePath(importer, target), external: true };
    build.onResolve({ filter: /^#sdk\// }, args => {
      const name = args.path.slice("#sdk/".length);
      if (!name || name.split("/").some(part => !part || part === "." || part === "..") || name.includes("\\")) throw new Error(`Invalid SDK import: ${args.path}`);
      const target = resolve(sourceDir, "sdk", `${name}.ts`);
      if (!existsSync(target) && !existsSync(target.replace(/\.ts$/, ".d.ts"))) throw new Error(`Unknown SDK import: ${args.path}`);
      return reference(args.importer, target);
    });
    build.onResolve({ filter: /^#capabilities\// }, args => {
      const channel = args.path.slice("#capabilities/".length);
      if (!Object.hasOwn(channels, channel)) throw new Error(`Unknown capability channel: ${channel}`);
      return reference(args.importer, resolve(sourceDir, `capability-catalogs/${channel}.ts`));
    });
    build.onResolve({ filter: /^\./ }, args => {
      if (build.initialOptions.format !== "iife" || !sources.has(args.importer)) return undefined;
      return { path: resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts") };
    });
    build.onResolve({ filter: /capability-catalogs[/\\].*\.ts$/ }, args => {
      const path = resolve(args.resolveDir, args.path);
      return sources.has(path) ? { path } : undefined;
    });
    build.onLoad({ filter: /capability-catalogs[/\\].*\.ts$/ }, args => {
      const contents = sources.get(args.path);
      return contents === undefined ? undefined : { contents, loader: "ts", resolveDir: dirname(args.path) };
    });
  } };
  return { paths, plugin, declarations, entries };
}

/** Assemble package-owned markup and styles into the same static browser/HTML-export surface. */
export async function capabilityUiAssets(sourceDir, { includes = () => true } = {}) {
  const resources = new Set();
  const html = [];
  const css = [];
  const graph = validateExtensionBoundaries(sourceDir);
  const discovered = graph.entries;
  const directories = [...new Set([...discovered.ui, ...discovered.renderers].map(dirname))].sort();
  for (const directory of directories) {
    for (const [name, target] of [["ui.html", html], ["ui.css", css]]) {
      const path = resolve(directory, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid capability UI resource: ${path}`);
      resources.add(path);
      target.push(path);
    }
  }
  const overrides = new Map();
  if (html.length) {
    const path = resolve(sourceDir, "sidepanel/sidepanel.html");
    const contents = readFileSync(path, "utf8");
    const slot = "<!-- capability-ui -->";
    if (contents.split(slot).length !== 2) throw new Error("Side Panel must have exactly one capability-ui HTML slot");
    const stylesheets = [];
    const fragments = html.map(file => relocateUiHtml(readFileSync(file, "utf8"), file, path, stylesheets)).join("\n");
    let assembled = contents.replace(slot, () => fragments);
    if (stylesheets.length) {
      // Dependency styles precede the active skin, exactly as in a handwritten document head.
      const skin = /<link\b(?=[^>]*\bid=["']qingzhou-sidepanel-skin["'])(?:[^"'<>]|"[^"]*"|'[^']*')*>/i;
      if (!skin.test(assembled)) throw new Error("Side Panel stylesheet contributions require an active skin link");
      assembled = assembled.replace(skin, tag => `${stylesheets.join("\n")}\n${tag}`);
    }
    overrides.set(path, assembled);
  }
  const path = resolve(sourceDir, "sidepanel/sidepanel.css");
  if (existsSync(path)) {
    const { compileStylesheet } = await import("./styles.mjs");
    const sources = [...graph.contexts.sidepanel, ...html];
    // Core UI and selected product sources participate without scanning tests or generated files.
    for (const directory of ["sidepanel", "shared", "products"]) collectStyleSources(resolve(sourceDir, directory), sources);
    const compiled = await compileStylesheet({ sourceDir, entry: path, stylesheets: css,
      sources: sources.filter(file => includes(posix(relative(sourceDir, file)))),
    });
    for (const file of compiled.dependencies) if (file !== path) resources.add(file);
    overrides.set(path, compiled.css);
  }
  return { overrides, resources };
}

function collectStyleSources(directory, files) {
  if (!existsSync(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) collectStyleSources(path, files);
    else if (item.isFile() && /\.(?:ts|html)$/.test(item.name)) files.push(path);
  }
}

/** Tokenize tags and attributes without interpreting comments or raw-text contents. */
function relocateUiHtml(html, source, destination, stylesheets) {
  const rebase = value => {
    const path = value.trim();
    if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(path)) return value;
    const suffixAt = path.search(/[?#]/);
    const pathname = suffixAt < 0 ? path : path.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? "" : path.slice(suffixAt);
    return value.replace(path, () => posix(relative(dirname(destination), resolve(dirname(source), pathname))) + suffix);
  };
  const urls = new Set(["src", "href", "poster", "data", "action", "formaction", "background", "xlink:href"]);
  const tags = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<![^>]*>|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  return html.replace(tags, token => {
    const tag = token.match(/^<([a-z][\w:-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/i)?.[0];
    if (!tag) return token;
    const start = tag.match(/^<([\w:-]+)/)[0];
    const attributes = new Map();
    const rewritten = start + tag.slice(start.length).replace(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
      (attribute, name, doubleQuoted, singleQuoted, unquoted) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted;
        const key = name.toLowerCase();
        attributes.set(key, value);
        if (value === undefined) return attribute;
        const next = key === "srcset" || key === "imagesrcset" ? relocateSrcset(value, rebase) : urls.has(key) ? rebase(value) : value;
        return next === value ? attribute : `${name}="${next.replaceAll('"', '&quot;')}"`;
      });
    if (start.toLowerCase() === "<link" && String(attributes.get("rel") || "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      stylesheets.push(rewritten);
      return "";
    }
    return rewritten + token.slice(tag.length);
  });
}

function relocateSrcset(value, rebase) {
  // A candidate URL ends at whitespace; commas inside a data URL are not separators.
  let output = "", cursor = 0;
  while (cursor < value.length) {
    let start = cursor;
    while (cursor < value.length && /[\s,]/.test(value[cursor])) cursor += 1;
    output += value.slice(start, cursor);
    start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor])) cursor += 1;
    const url = value.slice(start, cursor);
    const trailing = url.match(/,+$/)?.[0] || "";
    const path = trailing ? url.slice(0, -trailing.length) : url;
    output += rebase(path) + trailing;
    if (trailing) continue;
    start = cursor;
    let parentheses = 0;
    while (cursor < value.length && (value[cursor] !== "," || parentheses)) {
      if (value[cursor] === "(") parentheses += 1;
      if (value[cursor] === ")") parentheses = Math.max(0, parentheses - 1);
      cursor += 1;
    }
    output += value.slice(start, cursor);
  }
  return output;
}
