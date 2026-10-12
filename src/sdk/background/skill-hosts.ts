import type { SkillTool } from "../../shared/skills/skill-manifest.js";
import type { ToolContext } from "../background.js";
export interface SkillHostContext {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  tool: Readonly<SkillTool>; signal?: AbortSignal; context: ToolContext;
}
export type SkillHostDefinition = {
  skillName: string; manifestId: string; toolName: string;
} & ({ target: string; execute?: never } | {
  target?: never; execute(args: Record<string, unknown>, context: SkillHostContext): Promise<unknown>;
});
export interface SkillHostExtensionAPI { registerSkillHost(definition: SkillHostDefinition): void }
export type SkillHostExtension = (qz: SkillHostExtensionAPI) => void;
