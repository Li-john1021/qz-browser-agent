import type { SkillRecord } from "../skills/skill-utils.js";

export interface SkillWorkspaceSnapshot {
  skills: SkillRecord[];
}
export interface SkillWorkspaceSave { name: string; skill: SkillRecord; expected: SkillRecord | null }
export interface SkillWorkspaceImport { skills: SkillRecord[]; expected: Record<string, SkillRecord | null> }
export interface SkillWorkspaceDelete { name: string; expected: SkillRecord | null }
export interface SkillWorkspaceResult extends SkillWorkspaceSnapshot {
  ok: true; count: number; names: string[]; registryReady: boolean; skill?: SkillRecord;
}
