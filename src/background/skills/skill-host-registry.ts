import contributions from "#capabilities/skillHosts";
import { listBuiltinSkills } from "../../shared/skills/builtin-skills.js";
import { findSkillManifestResource, parseSkillManifest } from "../../shared/skills/skill-manifest.js";
import type { SkillManifest, SkillTool } from "../../shared/skills/skill-manifest.js";
import type { SkillRecord } from "../../shared/skills/skill-utils.js";
import { isTrustedSkillManifest } from "../../shared/skills/skill-provenance.js";
import type { SkillHostDefinition, SkillHostExtension } from "../../sdk/background/skill-hosts.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";

/** Host code is registered by trusted extension sources, never read from installed manifests. */
export function createSkillHostRegistry(factories: readonly SkillHostExtension[], skills: readonly SkillRecord[], localizedSkills: (language: string) => readonly SkillRecord[] = () => skills) {
  const bindings = new Map<string, { definition: SkillHostDefinition; tool: SkillTool }>();
  const manifests = new Map<string, SkillManifest | null>();
  // Compare the full contract in the run's language; translated schema text is not execution authority.
  const declarations = new Map<string, Map<string, SkillTool>>();
  function toolsForLanguage(language: string) {
    let tools = declarations.get(language);
    if (!tools) {
      tools = withLanguage(language, () => new Map(localizedSkills(language).flatMap(skill => {
        const resource = findSkillManifestResource(skill.resources);
        const plugin = resource ? parseSkillManifest(resource.content, skill).plugin : null;
        return plugin && isTrustedSkillManifest(plugin) ? plugin.tools.map(tool => [tool.name, tool] as const) : [];
      })));
      declarations.set(language, tools);
    }
    return tools;
  }
  const registerSkillHost = (definition: SkillHostDefinition) => {
    if (!manifests.has(definition.skillName)) {
      const skill = skills.find(item => item.name === definition.skillName);
      const resource = findSkillManifestResource(skill?.resources);
      manifests.set(definition.skillName, skill && resource ? parseSkillManifest(resource.content, skill).plugin : null);
    }
    const plugin = manifests.get(definition.skillName);
    const tool = plugin?.tools.find(item => item.localName === definition.toolName);
    if (!plugin || !isTrustedSkillManifest(plugin) || plugin.id !== definition.manifestId || !tool || tool.runtime !== "host") {
      throw new Error(`Skill host binding does not match a registered embedded manifest: ${definition.skillName}/${definition.manifestId}/${definition.toolName}`);
    }
    if ((typeof definition.target === "string") === (typeof definition.execute === "function")
      || (typeof definition.target === "string" && (!definition.target || definition.target !== tool.capabilityId))) {
      throw new Error(`Invalid Skill host implementation or capability binding: ${tool.name}`);
    }
    if (bindings.has(tool.name)) throw new Error(`Duplicate Skill host identity: ${tool.name}`);
    bindings.set(tool.name, { definition: Object.freeze({ ...definition }), tool });
  };
  for (const factory of factories) factory(Object.freeze({ registerSkillHost }));
  return Object.freeze({
    resolve(plugin: Partial<SkillManifest>, tool: Partial<SkillTool>, language = getLanguage()): SkillHostDefinition | null {
      if (!isTrustedSkillManifest(plugin) || !plugin.tools?.includes(tool as SkillTool)) return null;
      const binding = bindings.get(String(tool.name || ""));
      if (!binding || binding.definition.skillName !== plugin.skillName || binding.definition.manifestId !== plugin.id
        || JSON.stringify(toolsForLanguage(language).get(String(tool.name || ""))) !== JSON.stringify(tool)) return null;
      return binding.definition;
    },
    target(name: string) {
      const binding = [...bindings.values()].find(item => item.definition.target === name);
      return binding ? { skillName: binding.definition.skillName, toolName: binding.tool.name } : null;
    },
  });
}

const registry = createSkillHostRegistry(contributions, listBuiltinSkills(), listBuiltinSkills);
export const resolveSkillHostBinding = registry.resolve;
export const resolveSkillHostTarget = registry.target;
