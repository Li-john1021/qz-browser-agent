import assert from "node:assert/strict";
import {
  defaultWorkspaceView,
  loadWorkspaceBootstrap,
  loadWorkspaceView,
  normalizeWorkspaceView,
  saveWorkspaceView,
  workspaceViewStorageKey,
} from "../../src/sidepanel/features/app/workspace-view-store.js";

assert.deepEqual(defaultWorkspaceView(), { v: 2, page: "chat", state: { sessionId: null } });
assert.deepEqual(normalizeWorkspaceView(null), defaultWorkspaceView());
assert.deepEqual(normalizeWorkspaceView({ v: 99, page: "data", table: "old" }), defaultWorkspaceView());
for (const legacy of [
  { v: 1, page: "chat", sessionId: " s1 " },
  { v: 1, page: "sessions", mode: "other" },
  { v: 1, page: "sessions", mode: "automation" },
  { v: 1, page: "data", table: " orders " },
  { v: 1, page: "skills", skill: "" },
  { v: 1, page: "logs", extra: true },
]) {
  const { v, page, ...state } = legacy;
  assert.deepEqual(normalizeWorkspaceView(legacy), { v: 2, page, state }, "legacy fields must reach their owning page without loss");
}
assert.deepEqual(normalizeWorkspaceView({ v: 2, page: "new-capability", state: { selected: ["a", "b"] } }),
  { v: 2, page: "new-capability", state: { selected: ["a", "b"] } });
const cyclic = {}; cyclic.self = cyclic;
assert.deepEqual(normalizeWorkspaceView({ v: 2, page: "new-capability", state: cyclic }), defaultWorkspaceView());
assert.equal(workspaceViewStorageKey(7), "qingzhou:workspace-view:7");
assert.equal(workspaceViewStorageKey(-1), "");

const values = {};
const storageArea = {
  async get(key) {
    return { [key]: values[key] };
  },
  async set(patch) {
    Object.assign(values, patch);
  },
};

assert.equal(await saveWorkspaceView(storageArea, 3, {
  v: 1,
  page: "data",
  table: "events",
}), true);
assert.deepEqual(await loadWorkspaceView(storageArea, 3), {
  v: 2,
  page: "data",
  state: { table: "events" },
});
assert.deepEqual(await loadWorkspaceView(storageArea, 4), defaultWorkspaceView());
assert.equal(await saveWorkspaceView(null, 3, defaultWorkspaceView()), false);
const failingStorage = {
  async get() { throw new Error("forced read failure"); },
  async set() { throw new Error("forced write failure"); },
};
assert.deepEqual(await loadWorkspaceView(failingStorage, 3), defaultWorkspaceView());
assert.equal(await saveWorkspaceView(failingStorage, 3, defaultWorkspaceView()), false);

assert.deepEqual(await loadWorkspaceBootstrap({
  windowsApi: { getCurrent: async () => ({ id: 3 }) },
  storageArea,
}), {
  windowId: 3,
  view: { v: 2, page: "data", state: { table: "events" } },
});

assert.deepEqual(await loadWorkspaceBootstrap({
  windowsApi: { getCurrent: async () => ({ id: -1 }) },
  storageArea,
}), {
  windowId: null,
  view: defaultWorkspaceView(),
});

let releaseSlowRead;
const slowRead = new Promise(resolve => { releaseSlowRead = resolve; });
assert.deepEqual(await loadWorkspaceBootstrap({
  windowsApi: { getCurrent: async () => ({ id: 3 }) },
  storageArea: { get: () => slowRead },
  timeoutMs: 5,
}), {
  windowId: 3,
  view: defaultWorkspaceView(),
});
releaseSlowRead({ [workspaceViewStorageKey(3)]: { v: 1, page: "data", table: "late" } });

assert.deepEqual(await loadWorkspaceBootstrap({
  windowsApi: { getCurrent: async () => ({ id: 3 }) },
  storageArea: null,
}), {
  windowId: 3,
  view: defaultWorkspaceView(),
});

assert.deepEqual(await loadWorkspaceBootstrap({
  windowsApi: { getCurrent: async () => { throw new Error("forced window failure"); } },
  storageArea,
}), {
  windowId: null,
  view: defaultWorkspaceView(),
});

console.log("workspace view store tests passed");
