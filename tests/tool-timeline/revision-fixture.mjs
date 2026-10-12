import { parse } from "acorn";
import { existsSync } from "node:fs";
import { join } from "node:path";

const modules = {
  "sidepanel/tools/tool-renderer.js": ["sidepanel/tool-renderer.js"],
  "sidepanel/tools/tool-model.js": ["sidepanel/tool-model.js"],
  "sidepanel/tools/tool-timeline-renderer.js": ["sidepanel/tool-timeline-renderer.js"],
  "sidepanel/tools/skill-tool-ui-registry.js": ["sidepanel/skill-tool-ui-registry.js", "sidepanel/plugin-ui-registry.js"],
  "sidepanel/ui/scroll-tail-controller.js": ["sidepanel/scroll-tail-controller.js"],
  "sidepanel/ui/ui-utils.js": ["sidepanel/ui-utils.js"],
  "shared/skills/skill-renderers.js": ["shared/skill-renderers.js", "shared/plugin-renderers.js"],
};
const legacyExports = {
  "sidepanel/plugin-ui-registry.js": { enrichSkillToolIdentity: "enrichPluginToolIdentity", setSkillToolUiCatalog: "setPluginToolUiCatalog" },
  "shared/plugin-renderers.js": { listSkillRendererDefinitions: "listPluginRendererDefinitions" },
};

/** Adapt fixture imports only; both revisions execute their untouched production modules. */
export function createRevisionFixtureAdapter(extensionDir) {
  function resolveModule(url) {
    const current = url.replace(/^\/extension\//, "");
    if (!Object.hasOwn(modules, current)) return { url, exports: {} };
    const selected = [current, ...modules[current]].find(path => existsSync(join(extensionDir, path)));
    if (!selected) throw new Error(`Revision is missing fixture module: ${current}`);
    return { url: `/extension/${selected}`, exports: legacyExports[selected] || {} };
  }
  function module(source) {
    const edits = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
        const literal = node.source;
        if (typeof literal?.value === "string") {
          const target = resolveModule(literal.value);
          if (target.url !== literal.value) edits.push([literal.start, literal.end, JSON.stringify(target.url)]);
          for (const specifier of node.specifiers || []) {
            const exported = target.exports[specifier.imported?.name];
            if (exported) edits.push([specifier.start, specifier.end, `${exported} as ${specifier.local.name}`]);
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
    return edits.sort(([a], [b]) => b - a).reduce((text, [start, end, replacement]) => text.slice(0, start) + replacement + text.slice(end), source);
  }
  return {
    moduleUrl: url => resolveModule(url).url,
    source(path, source) {
      return path.endsWith(".html")
        ? source.replace(/(<script\b[^>]*\btype=["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (_match, open, body, close) => open + module(body) + close)
        : module(source);
    },
  };
}
