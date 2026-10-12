import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityStateStore } from "../../src/shared/capability-state-store.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const owner = (storage, name = "example.ui", controller = new AbortController()) => ({
  store: createCapabilityStateStore(name, storage, controller.signal), controller,
});

test("capability storage isolates owners and copies JSON at both boundaries", async () => {
  const storage = createMemoryStorage();
  const first = owner(storage).store;
  const second = owner(storage, "second.ui").store;
  const value = { title: "Saved", rows: [1, true, null] };
  const saving = first.set("preferences", value);
  value.title = "Changed after dispatch";
  await saving;
  await second.set("preferences", "Other owner");
  const read = await first.get("preferences");
  assert.deepEqual(read, { title: "Saved", rows: [1, true, null] });
  read.rows.push("local edit");
  assert.deepEqual(await first.get("preferences"), { title: "Saved", rows: [1, true, null] });
  assert.equal(await second.get("preferences"), "Other owner");
  await first.remove("preferences");
  assert.equal(await first.get("preferences"), undefined);
  assert.equal(await second.get("preferences"), "Other owner");
  assert.equal(await owner(storage).store.get("preferences"), undefined);
});

test("storage rejects non-JSON values, oversized UTF-8 and escaped names without writing", async () => {
  const storage = createMemoryStorage();
  const { store } = owner(storage);
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, "value", { enumerable: true, get() { throw new Error("must not execute"); } });
  const customArray = [1]; customArray.toJSON = () => "hidden";
  class ConvertedArray extends Array { toJSON() { throw new Error("must not execute"); } }
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cycle, accessor, [undefined], new Array(1), customArray, new ConvertedArray(1), { [Symbol("hidden")]: 1 }]) {
    await assert.rejects(store.set("bad", value), /JSON/);
  }
  await assert.rejects(store.set("large", "你".repeat(22000)), /64 KiB/);
  for (const key of ["", "../another", "owner:key", "a".repeat(101)]) {
    await assert.rejects(store.get(key), /Invalid.*key/);
    await assert.rejects(store.set(key, true), /Invalid.*key/);
    await assert.rejects(store.remove(key), /Invalid.*key/);
  }
  assert.throws(() => owner(storage, "another:owner"), /Invalid.*owner/);
  assert.deepEqual(storage.writes, []);
  await store.set("limit", "a".repeat(65534));
  assert.equal((await store.get("limit")).length, 65534);
});

test("failed operations recover and a remount observes the preceding owner's submitted write", async () => {
  const base = createMemoryStorage();
  const started = deferred();
  const finish = deferred();
  let fail = true;
  const storage = { ...base, async set(value) {
    if (fail) { fail = false; throw new Error("disk unavailable"); }
    started.resolve(); await finish.promise; await base.set(value);
  } };
  const first = owner(storage);
  await assert.rejects(first.store.set("value", "failed"), /disk unavailable/);
  const pending = first.store.set("value", "submitted before unmount");
  const cancelled = assert.rejects(pending, /abort/i);
  await started.promise;
  const queued = first.store.set("value", "queued obsolete write");
  const queuedCancelled = assert.rejects(queued, /abort/i);
  first.controller.abort();
  const second = owner(storage);
  const recovered = second.store.get("value");
  finish.resolve();
  await Promise.all([cancelled, queuedCancelled]);
  assert.equal(await recovered, "submitted before unmount");
  assert.equal(base.writes.length, 1);
  await second.store.set("value", "new mount");
  assert.equal(await second.store.get("value"), "new mount");
});

test("operation cancellation and owner cancellation reject late reads without crossing owners", async () => {
  const gate = deferred();
  const started = deferred();
  const storage = { async get(key) { started.resolve(); await gate.promise; return { [key]: "late" }; }, async set() {}, async remove() {} };
  const mounted = owner(storage);
  const operation = new AbortController();
  const pending = mounted.store.get("value", { signal: operation.signal });
  const cancelled = assert.rejects(pending, /abort/i);
  await started.promise;
  operation.abort(); gate.resolve(); await cancelled;
  assert.equal(await mounted.store.get("value"), "late");
  mounted.controller.abort();
  await assert.rejects(mounted.store.get("value"), /abort/i);
  await assert.rejects(mounted.store.set("value", "late"), /abort/i);
  await assert.rejects(mounted.store.remove("value"), /abort/i);
  assert.equal(await owner(storage, "other").store.get("value"), "late");
});
