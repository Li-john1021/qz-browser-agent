import { createSkillStateRepository } from "./skill-repository.js";
import type { StorageAdapter } from "../internal/storage.js";
import {
  GIT_SKILL_SOURCE_STATE_KEY,
  normalizeGitSkillSources,
} from "../../shared/skills/git-skill-sources.js";

const SKILLS_STORAGE_KEY = "_skills";

export function createGitSkillSourceRepository({ storage = globalThis.chrome?.storage?.local }: { storage?: Pick<StorageAdapter, "get" | "set"> } = {}) {
  if (!storage?.get || !storage?.set) throw new TypeError("Git skill source repository requires storage");

  const stateRepository = createSkillStateRepository({ storage });
  async function readSnapshot() {
    const stored = await stateRepository.read([SKILLS_STORAGE_KEY, GIT_SKILL_SOURCE_STATE_KEY]);
    return {
      skills: normalizeRecord(stored?.[SKILLS_STORAGE_KEY]),
      sources: normalizeGitSkillSources(stored?.[GIT_SKILL_SOURCE_STATE_KEY]),
    };
  }

  async function listSources() {
    return Object.values((await readSnapshot()).sources);
  }

  async function getSource(sourceId = "") {
    const id = String(sourceId || "").trim();
    if (!id) return null;
    return (await readSnapshot()).sources[id] || null;
  }

  async function commitSnapshot({ skills, sources, expected }: {
    skills: unknown; sources: unknown; expected: { skills: unknown; sources: unknown };
  }) {
    const committed = await stateRepository.commit({
      [SKILLS_STORAGE_KEY]: normalizeRecord(expected.skills),
      [GIT_SKILL_SOURCE_STATE_KEY]: normalizeGitSkillSources(expected.sources),
    }, {
      [SKILLS_STORAGE_KEY]: normalizeRecord(skills),
      [GIT_SKILL_SOURCE_STATE_KEY]: normalizeGitSkillSources(sources),
    });
    return { skills: committed[SKILLS_STORAGE_KEY], sources: normalizeGitSkillSources(committed[GIT_SKILL_SOURCE_STATE_KEY]) };
  }

  return Object.freeze({
    readSnapshot,
    listSources,
    getSource,
    commitSnapshot,
  });
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
}
