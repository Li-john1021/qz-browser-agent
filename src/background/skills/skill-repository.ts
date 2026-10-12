import { t } from "../../shared/i18n/backend.js";
import type { StorageAdapter } from "../internal/storage.js";
import { structuredCloneSafe } from "../internal/storage.js";
import { createSerialQueue } from "../internal/serial-queue.js";

type Records = Record<string, unknown>;
type State = Record<string, Records>;
const namespaces = new Set(["_skills", "_gitSkillSources"]);
const writes = createSerialQueue();
const records = (value: unknown): Records => value && typeof value === "object" && !Array.isArray(value) ? value as Records : {};

export function skillWriteConflict(name: string) {
  return Object.assign(new Error(t("skill.concurrentChange", { name: String(name) })), { code: "SKILL_WRITE_CONFLICT", skillName: name });
}

export function sameSkillRecord(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameSkillRecord(value, right[index]));
  }
  const a = records(left), b = records(right);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameSkillRecord(a[key], b[key]));
}

/** Shared optimistic write boundary for local, Git and page Skill packages. */
export function createSkillStateRepository({ storage = globalThis.chrome?.storage?.local }: { storage?: Pick<StorageAdapter, "get" | "set"> } = {}) {
  if (!storage?.get || !storage.set) throw new TypeError("Skill repository requires storage");
  const area = storage;
  async function read(keys = ["_skills"]): Promise<State> {
    if (keys.some(key => !namespaces.has(key))) throw new TypeError("Unsupported Skill storage namespace");
    const stored = await area.get(keys);
    return Object.fromEntries(keys.map(key => [key, structuredCloneSafe(records(stored[key]))]));
  }
  function commit(expected: State, next: State, readSet: Record<string, readonly string[]> = {}): Promise<State> {
    return writes.run(async () => {
      const keys = Object.keys(next);
      if (keys.some(key => !Object.hasOwn(expected, key))) throw new TypeError("Skill writes require an expected snapshot");
      const current = await read(keys);
      for (const key of keys) {
        const before = expected[key], after = next[key];
        const required = new Set(readSet[key] || []);
        for (const name of new Set([...Object.keys(before), ...Object.keys(after), ...required])) {
          const changed = !sameSkillRecord(before[name], after[name]);
          if (!changed && !required.has(name)) continue;
          if (!sameSkillRecord(before[name], current[key][name])) throw skillWriteConflict(name);
          if (!changed) continue;
          if (Object.hasOwn(after, name)) current[key][name] = structuredCloneSafe(after[name]);
          else delete current[key][name];
        }
      }
      await area.set(structuredCloneSafe(current));
      return current;
    });
  }
  return Object.freeze({ read, commit });
}
