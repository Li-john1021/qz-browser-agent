import { t } from "./i18n.js";
import { getLanguage } from "#sdk/shared/i18n";
import * as zh from "./prompts/site-author-zh-CN.js";
import * as en from "./prompts/site-author-en.js";

export const BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME = "site-skill-author";
export const getBuiltinSiteSkillAuthorDisplayName = () => (t("siteAuthorName"));
export const getBuiltinSiteSkillAuthorDescription = () => (t("siteAuthorDescription"));
export const getBuiltinSiteSkillAuthorContent = () => (getLanguage() === "zh-CN" ? zh.content : en.content);

export default {
  name: BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME, get displayName() { return getBuiltinSiteSkillAuthorDisplayName(); },
  aliases: [zh.displayName, en.displayName],
  get description() { return getBuiltinSiteSkillAuthorDescription(); }, get content() { return getBuiltinSiteSkillAuthorContent(); },
  resources: [], order: 1,
};
