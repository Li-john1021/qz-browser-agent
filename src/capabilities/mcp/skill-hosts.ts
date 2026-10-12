import type { SkillHostExtension } from "#sdk/background/skill-hosts";
import { MCP_TOOL_CORE_NAMES as targets } from "./skill-contract.js";
const register: SkillHostExtension = qz => {
  for (const target of targets) qz.registerSkillHost({ skillName: "qingzhou-mcp", manifestId: "qingzhou-mcp", toolName: target, target });
};
export default register;
