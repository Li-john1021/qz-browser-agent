import type { SkillHostExtension } from "#sdk/background/skill-hosts";
import { DOCUMENT_TOOL_CORE_NAMES as targets } from "./skill-contract.js";
const register: SkillHostExtension = qz => {
  for (const target of targets) qz.registerSkillHost({ skillName: "qingzhou-documents", manifestId: "qingzhou-documents", toolName: target, target });
};
export default register;
