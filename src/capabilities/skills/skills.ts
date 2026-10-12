import type { SkillExtension } from "#sdk/shared/skill-definition";
import workbench from "./workbench.js";
import siteAuthor from "./site-author.js";

const register: SkillExtension = qz => {
  qz.registerSkill(workbench);
  qz.registerSkill(siteAuthor);
};
export default register;
