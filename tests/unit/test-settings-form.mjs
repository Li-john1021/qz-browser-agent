import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsForm } from "../../src/sdk/sidepanel/settings-form.ts";

const deferred = () => Promise.withResolvers();

function fixture(options = {}) {
  const lifetime = new AbortController();
  let generation = 1;
  let draft;
  let stored = options.initialValue ?? "initial";
  let activation;
  const states = [];
  const writes = [];
  const reads = [];
  const form = createSettingsForm({ signal: lifetime.signal, settings: { getOpenGeneration: () => generation } }, {
    initialValue: stored,
    getDraft: () => draft,
    setDraft: value => { draft = value; },
    load: async signal => { reads.push(signal); return stored; },
    save: async (value, signal) => { writes.push({ value, signal }); stored = value; },
    ...options,
    renderState: state => states.push(state),
  });
  return {
    form, lifetime, states, reads, writes,
    get draft() { return draft; },
    get state() { return states.at(-1); },
    get stored() { return stored; },
    edit(value) { draft = value; form.changed(); },
    activate() { activation = new AbortController(); return form.activate({ signal: activation.signal, refresh: false }); },
    deactivate() { activation.abort(); form.deactivate(); },
    reopen() { this.deactivate(); generation += 1; return this.activate(); },
    save() { return form.save({ signal: activation.signal, refresh: false }); },
  };
}

test("settings form saves an edited value and retains its success across tab switches", async () => {
  const f = fixture();
  await f.activate();
  assert.deepEqual(f.state, { phase: "idle", dirty: false, error: undefined });
  f.edit("edited");
  assert.equal(f.state.dirty, true);
  assert.equal(await f.save(), true);
  assert.equal(f.stored, "edited");
  assert.deepEqual(f.state, { phase: "saved", dirty: false, error: undefined });
  f.deactivate();
  await f.activate();
  assert.equal(f.state.phase, "saved");
  assert.equal(f.reads.length, 1);
});

test("tab switches preserve a draft while reopening discards it and rereads storage", async () => {
  const f = fixture();
  await f.activate();
  f.edit("draft");
  f.deactivate();
  await f.activate();
  assert.equal(f.draft, "draft");
  assert.equal(f.reads.length, 1);
  await f.reopen();
  assert.equal(f.draft, "initial");
  assert.equal(f.state.dirty, false);
  assert.equal(f.reads.length, 2);
});

test("a load sets the saved baseline without overwriting a newer edit", async () => {
  const read = deferred();
  const f = fixture({ load: () => read.promise });
  const loading = f.activate();
  assert.equal(f.state.phase, "loading");
  f.edit("edited while loading");
  assert.equal(await f.save(), false);
  read.resolve("stored");
  await loading;
  assert.equal(f.draft, "edited while loading");
  assert.equal(f.state.dirty, true);
  f.edit("stored");
  assert.equal(f.state.dirty, false);
});

test("leaving a loading form preserves input and ignores the cancelled read", async () => {
  const read = deferred();
  let signal;
  const f = fixture({ load: received => { signal = received; return read.promise; } });
  const loading = f.activate();
  f.edit("new draft");
  f.deactivate();
  assert.equal(signal.aborted, true);
  const count = f.states.length;
  read.resolve("old stored");
  await loading;
  assert.equal(f.states.length, count);
  await f.activate();
  assert.equal(f.draft, "new draft");
  assert.equal(f.state.phase, "idle");
});

for (const opening of ["first open", "reopen"]) {
  test(`an edited placeholder during a cancelled ${opening} read cannot be mistaken for a saved value`, async () => {
    const read = deferred();
    let ready = opening === "reopen";
    const f = fixture({ load: () => ready ? "initial" : read.promise });
    let loading;
    if (ready) {
      await f.activate();
      ready = false;
      loading = f.reopen();
    } else loading = f.activate();
    f.edit("temporary edit");
    f.edit("initial");
    f.deactivate();
    read.resolve("persisted-other-value");
    await loading;
    await f.activate();
    assert.equal(f.draft, "initial");
    assert.equal(f.state.dirty, true);
    assert.equal(await f.save(), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].value, "initial");
    assert.equal(f.state.dirty, false);
  });
}

test("a previous open's late read cannot replace a new open's draft or status", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const f = fixture({ load: () => (++calls === 1 ? first : second).promise });
  const oldLoad = f.activate();
  const newLoad = f.reopen();
  second.resolve("fresh");
  await newLoad;
  f.edit("fresh edit");
  const count = f.states.length;
  first.resolve("obsolete");
  await oldLoad;
  assert.equal(f.draft, "fresh edit");
  assert.equal(f.states.length, count);
});

test("failed loads keep the form editable and a later open retries", async () => {
  const error = new Error("storage unavailable");
  let fail = true;
  const f = fixture({ load: () => { if (fail) throw error; return "recovered"; } });
  await f.activate();
  assert.deepEqual(f.state, { phase: "load-error", dirty: false, error });
  f.edit("recover by saving");
  assert.equal(await f.save(), true);
  fail = false;
  await f.reopen();
  assert.equal(f.draft, "recovered");
  assert.equal(f.state.phase, "idle");
});

test("returning to a failed, unedited form retries its load within the same open", async () => {
  let calls = 0;
  const f = fixture({ load: () => { if (++calls === 1) throw new Error("read failed"); return "recovered"; } });
  await f.activate();
  assert.equal(f.state.phase, "load-error");
  f.deactivate();
  await f.activate();
  assert.equal(f.draft, "recovered");
  assert.equal(f.state.phase, "idle");
});

for (const failure of ["throw", "false"]) {
  test(`a ${failure} save reports failure, preserves the draft, and supports retry`, async () => {
    const error = new Error("write failed");
    let failing = true;
    const f = fixture({ save: () => {
      if (!failing) return;
      if (failure === "throw") throw error;
      return false;
    } });
    await f.activate();
    f.edit("pending");
    assert.equal(await f.save(), false);
    assert.equal(f.state.phase, "save-error");
    assert.equal(f.state.dirty, true);
    assert.equal(f.draft, "pending");
    if (failure === "throw") assert.equal(f.state.error, error);
    failing = false;
    assert.equal(await f.save(), true);
    assert.deepEqual(f.state, { phase: "saved", dirty: false, error: undefined });
  });
}

test("editing during a save keeps the newer draft dirty after the submitted snapshot succeeds", async () => {
  const write = deferred();
  let submitted;
  const f = fixture({ save: value => { submitted = value; return write.promise; } });
  await f.activate();
  f.edit("submitted");
  const saving = f.save();
  assert.equal(f.state.phase, "saving");
  assert.equal(await f.save(), false);
  f.edit("newer");
  write.resolve();
  assert.equal(await saving, true);
  assert.equal(submitted, "submitted");
  assert.equal(f.draft, "newer");
  assert.deepEqual(f.state, { phase: "idle", dirty: true, error: undefined });
});

for (const outcome of ["resolve", "reject"]) {
  test(`a cancelled save that later ${outcome}s cannot report success or overwrite the reactivated form`, async () => {
    const write = deferred();
    let signal;
    const f = fixture({ save: (_, received) => { signal = received; return write.promise; } });
    await f.activate();
    f.edit("pending");
    const saving = f.save();
    f.deactivate();
    assert.equal(signal.aborted, true);
    await f.activate();
    f.edit("next draft");
    const count = f.states.length;
    write[outcome](outcome === "reject" ? new Error("late failure") : undefined);
    assert.equal(await saving, false);
    assert.equal(f.states.length, count);
    assert.equal(f.draft, "next draft");
    assert.equal(f.state.dirty, true);
  });
}

test("cancellation does not pretend to undo an already submitted write; reopening reads persisted truth", async () => {
  const write = deferred();
  let stored = "initial";
  const f = fixture({
    load: () => stored,
    save: async value => { await write.promise; stored = value; },
  });
  await f.activate();
  f.edit("committed after leaving");
  const saving = f.save();
  f.deactivate();
  write.resolve();
  assert.equal(await saving, false);
  assert.equal(stored, "committed after leaving");
  await f.reopen();
  assert.equal(f.draft, stored);
  assert.equal(f.state.dirty, false);
});

test("cancelling only a save signal restores retryability without treating the old baseline as persisted", async () => {
  const write = deferred();
  let stored = "initial";
  let calls = 0;
  const f = fixture({ save: async value => {
    if (++calls === 1) await write.promise;
    stored = value;
  } });
  await f.activate();
  f.edit("submitted");
  const controller = new AbortController();
  const saving = f.form.save({ signal: controller.signal, refresh: false });
  controller.abort();
  f.edit("initial");
  write.resolve();
  assert.equal(await saving, false);
  assert.equal(stored, "submitted");
  assert.deepEqual(f.state, { phase: "idle", dirty: true, error: undefined });
  assert.equal(await f.save(), true);
  assert.equal(calls, 2);
  assert.equal(stored, "initial");
  assert.equal(f.state.dirty, false);
});

test("an old cancelled save's finally cannot clear a newer activation's pending save", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const f = fixture({ save: () => (++calls === 1 ? first : second).promise });
  await f.activate();
  f.edit("old submission");
  const oldSave = f.save();
  f.deactivate();
  await f.activate();
  f.edit("new submission");
  const newSave = f.save();
  const count = f.states.length;
  first.reject(new Error("obsolete failure"));
  assert.equal(await oldSave, false);
  assert.equal(f.state.phase, "saving");
  assert.equal(f.states.length, count);
  second.resolve();
  assert.equal(await newSave, true);
  assert.deepEqual(f.state, { phase: "saved", dirty: false, error: undefined });
});

test("object drafts and submitted values are isolated snapshots with explicit field equality", async () => {
  const write = deferred();
  let submitted;
  const initial = { value: "initial" };
  const f = fixture({
    initialValue: initial,
    equals: (a, b) => a.value === b.value,
    save: value => { submitted = value; return write.promise; },
  });
  await f.activate();
  f.draft.value = "submitted";
  f.form.changed();
  assert.equal(initial.value, "initial");
  const saving = f.save();
  f.draft.value = "newer";
  f.form.changed();
  assert.equal(submitted.value, "submitted");
  // A persistence adapter mutating its own copy must not alter the saved baseline either.
  submitted.value = "adapter copy";
  write.resolve();
  await saving;
  assert.equal(f.draft.value, "newer");
  f.edit({ value: "submitted" });
  assert.equal(f.state.dirty, false);
});

for (const pending of ["load", "save"]) {
  test(`unmounting suppresses a pending ${pending}, its signal and all later input`, async () => {
    const operation = deferred();
    let signal;
    const f = fixture(pending === "load"
      ? { load: received => { signal = received; return operation.promise; } }
      : { save: (_, received) => { signal = received; return operation.promise; } });
    let running = f.activate();
    if (pending === "save") {
      await running;
      f.edit("pending");
      running = f.save();
    }
    f.lifetime.abort();
    assert.equal(signal.aborted, true);
    const count = f.states.length;
    f.edit("post-unmount input");
    operation.resolve("late");
    await running;
    await f.activate();
    assert.equal(await f.save(), false);
    assert.equal(f.states.length, count);
  });
}
