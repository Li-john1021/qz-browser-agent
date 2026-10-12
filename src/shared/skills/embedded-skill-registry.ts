import type { SkillDefinition, SkillExtension } from "../../sdk/shared/skill-definition.js";
import { isValidAgentSkillName, normalizeModernSkill, normalizeSkillLookup, toAgentSkillName } from "./skill-utils.js";
import { trustEmbeddedSkill } from "./skill-provenance.js";

/** Embedded declarations use the same records as installed Skills; only their provenance differs. */
export function createEmbeddedSkillRegistry(contributions: readonly SkillExtension[]) {
  const definitions: SkillDefinition[] = [];
  const aliases = new Map<string, string>();
  const registerSkill = (definition: SkillDefinition) => {
    if (!isValidAgentSkillName(definition.name)) throw new Error(`Invalid embedded Skill name: ${definition.name}`);
    if (typeof definition.content !== "string" || typeof definition.description !== "string") throw new Error(`Invalid embedded Skill content: ${definition.name}`);
    if (definition.aliases !== undefined && (!Array.isArray(definition.aliases) || definition.aliases.some(alias => typeof alias !== "string" || !normalizeSkillLookup(alias)))) {
      throw new Error(`Invalid embedded Skill aliases: ${definition.name}`);
    }
    const keys = [...new Set([definition.name, definition.displayName || definition.name, ...(definition.aliases || [])].map(normalizeSkillLookup))];
    const duplicate = keys.find(key => aliases.has(key));
    if (duplicate) throw new Error(`Duplicate embedded Skill name or display alias: ${definition.name} conflicts with ${aliases.get(duplicate)}`);
    if (definition.order !== undefined && !Number.isFinite(definition.order)) throw new Error(`Invalid embedded Skill order: ${definition.name}`);
    for (const key of keys) aliases.set(key, definition.name);
    definitions.push(structuredClone(definition));
  };
  for (const register of contributions) register(Object.freeze({ registerSkill }));
  const skills = definitions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(({ order: _order, aliases: _aliases, displayName, ...definition }) => normalizeModernSkill({
    ...definition,
    metadata: { displayName: displayName || definition.name },
    scope: definition.scope || "global", status: "active", builtin: true, readOnly: true, source: "system",
    domains: definition.domains || [], urlPatterns: definition.urlPatterns || [], excludePatterns: definition.excludePatterns || [],
    resources: definition.resources || [], createdAt: "system", updatedAt: "system",
  }));
  return Object.freeze({
    list: () => skills.map(skill => trustEmbeddedSkill(structuredClone(skill))),
    get: (name: string) => {
      const lookup = normalizeSkillLookup(name);
      if (!lookup) return null;
      const canonical = aliases.get(lookup) ?? aliases.get(normalizeSkillLookup(toAgentSkillName(name)));
      const skill = skills.find(item => item.name === canonical);
      return skill ? trustEmbeddedSkill(structuredClone(skill)) : null;
    },
  });
}
