import { t } from "./i18n.js";
import type { UiReferenceSource } from "#sdk/sidepanel";
import { isBuiltinSkill } from "#sdk/shared/skills";
import { getSkillDisplayName, matchSiteSkillsForUrls, SKILL_SCOPE_RESIDENT, type SkillRecord } from "#sdk/shared/skills";

export function createSkillReferences(list: () => Promise<SkillRecord[]>, siteUrls: () => Promise<string[]>): UiReferenceSource {
  return {
    id: "skill", label: t("skills"), menuLabel: "Skill", filterLabel: "skill", className: "skill", order: 20,
    emptyText: t("noMatchingSkills"),
    async list(signal) {
      const [skills, urls] = await Promise.all([list(), siteUrls().catch(() => [])]);
      signal.throwIfAborted();
      const enabled = skills.filter(skill => skill.name && skill.status !== "disabled");
      const siteNames = new Set(matchSiteSkillsForUrls(enabled, urls, { limit: 20 }).map(skill => skill.name));
      return enabled.map(skill => {
        const displayName = getSkillDisplayName(skill) || skill.name;
        return {
          kind: "skill", name: skill.name, label: displayName, title: displayName,
          subtitle: skill.description || "",
          meta: isBuiltinSkill(skill) ? t("builtInSkill") : skill.scope === SKILL_SCOPE_RESIDENT ? t("residentSkill") : siteNames.has(skill.name) ? t("siteSkill") : t("skills"),
          priority: siteNames.has(skill.name) ? 0 : 2,
          search: [skill.name, displayName, skill.description, skill.scope, ...(skill.domains || []), ...(skill.urlPatterns || [])].join(" ").toLowerCase(),
        };
      });
    },
  };
}
