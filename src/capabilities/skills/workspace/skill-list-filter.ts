import type { SkillRecord } from "#sdk/shared/skills";
import { isBuiltinSkill } from "#sdk/shared/skills";
import { matchesSkillSearch } from "#sdk/shared/skills";

export const SKILL_LIST_FILTER_MINE = "mine";
export const SKILL_LIST_FILTER_BUILTIN = "builtin";

export function normalizeSkillListFilter(value: unknown = "") {
  return value === SKILL_LIST_FILTER_BUILTIN
    ? SKILL_LIST_FILTER_BUILTIN
    : SKILL_LIST_FILTER_MINE;
}

export function filterSkillsForList(skills: SkillRecord[] = [], { filter = SKILL_LIST_FILTER_MINE, query = "" } = {}) {
  const normalizedFilter = normalizeSkillListFilter(filter);
  return (Array.isArray(skills) ? skills : []).filter((skill) => {
    const builtin = isBuiltinSkill(skill);
    if (normalizedFilter === SKILL_LIST_FILTER_BUILTIN ? !builtin : builtin) return false;
    return matchesSkillSearch(skill, query);
  });
}
