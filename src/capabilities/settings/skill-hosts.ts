import type { SkillHostExtension } from "#sdk/background/skill-hosts";
const targets = ["manage_settings", "manage_guardrails", "manage_skill_settings"];
const register: SkillHostExtension = qz => {
  for (const target of targets) qz.registerSkillHost({ skillName: "qingzhou-management", manifestId: "qingzhou-management", toolName: target, target });
};
export default register;
