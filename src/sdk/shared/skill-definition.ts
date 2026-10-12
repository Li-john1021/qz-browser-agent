/** Definition-only entry: embedded contributions must never load the live Skill catalog. */
export interface SkillDefinition {
  name: string; displayName?: string; description: string; content: string; order?: number;
  /** Stable lookup aliases, including display names in other supported languages. Not stored in user Skill records. */
  aliases?: readonly string[];
  scope?: "global" | "site" | "resident";
  domains?: readonly string[]; urlPatterns?: readonly string[]; excludePatterns?: readonly string[];
  resources?: readonly { path: string; type: string; title?: string; description?: string; content?: string; encoding?: string; mimeType?: string; size?: number }[];
}
export interface SkillExtensionAPI { registerSkill(definition: SkillDefinition): void }
export type SkillExtension = (qz: SkillExtensionAPI) => void;
export { SKILL_MANIFEST_PATH, SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "../../shared/skills/skill-format.js";
export { createSkillHostResources } from "../../shared/skills/skill-host-resources.js";
