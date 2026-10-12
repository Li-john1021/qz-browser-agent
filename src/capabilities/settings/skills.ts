import type { SkillExtension } from "#sdk/shared/skill-definition";
import embedded from "./embedded-skill.js";

const register: SkillExtension = qz => {
  qz.registerSkill(embedded);
};
export default register;
