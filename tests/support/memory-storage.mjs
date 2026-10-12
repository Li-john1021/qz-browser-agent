/** Dependency-free storage double shared by Node and browser fixtures. */
export function createMemoryStorage(seed = {}) {
  const state = structuredClone(seed);
  const writes = [];

  return {
    async get(keys = null) {
      if (keys == null) return structuredClone(state);
      if (typeof keys === "string") return { [keys]: structuredClone(state[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(state[key])]));
      }
      if (typeof keys === "object") {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
          key,
          state[key] === undefined ? structuredClone(fallback) : structuredClone(state[key]),
        ]));
      }
      return {};
    },
    async set(patch) {
      writes.push({ type: "set", patch: structuredClone(patch) });
      Object.assign(state, structuredClone(patch));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      writes.push({ type: "remove", keys: [...list] });
      for (const key of list) delete state[key];
    },
    snapshot() {
      return structuredClone(state);
    },
    writes,
  };
}

