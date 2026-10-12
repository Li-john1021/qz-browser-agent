import assert from "node:assert/strict";
import test from "node:test";
import { createSidepanelUiRuntime } from "../../src/sidepanel/capability-host/runtime.js";
import { normalizeWorkspaceView } from "../../src/sidepanel/features/app/workspace-view-store.js";
import { createWorkspaceExtensions } from "../../src/sidepanel/features/app/workspace-extensions.js";
import { createSessionState } from "../../src/sidepanel/features/sessions/session-state.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

function fixture() {
  const errors = [];
  const runtime = createSidepanelUiRuntime({ host: { root: {}, settings: {}, extensions: {} },
    onError: (error, context) => errors.push({ message: String(error), ...context }) });
  return { runtime, errors };
}
const page = (id, extra = {}) => ({ id, title: id, elements: [], ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("file-discovered UI factories register atomically and use one scoped event API", async () => {
  const errors = [], received = [];
  const extensions = createWorkspaceExtensions();
  const runtime = createSidepanelUiRuntime({ host: { root: {}, settings: {}, extensions }, storage: createMemoryStorage(),
    onError: error => errors.push(String(error)) });
  let qz;
  await runtime.mountAll([{ id: "example", setup(api) {
    qz = api;
    api.registerPage(page("example"));
    api.on("accepted", event => received.push(event.value));
    api.on("local", event => received.push(event.value));
    api.on("broken", () => { throw new Error("isolated"); });
  } }]);
  assert.equal(qz.onEvent, undefined);
  assert.equal(qz.extensions.onEvent, undefined);
  assert.equal(runtime.getPages()[0].id, "example");
  runtime.emit({ type: "accepted", value: "background" });
  extensions.notify({ type: "local", value: "UI" });
  runtime.emit({ type: "irrelevant", value: "ignore" });
  extensions.notify({ type: "broken" });
  assert.deepEqual(received, ["background", "UI"]);
  assert.match(errors[0], /isolated/);
  assert.throws(() => qz.registerPage(page("late")), /during extension setup/);
  await qz.storage.set("choice", "retained");
  await runtime.unmount("example");
  runtime.emit({ type: "accepted", value: "late" });
  extensions.notify({ type: "local", value: "late" });
  assert.deepEqual(received, ["background", "UI"]);
  await assert.rejects(qz.storage.set("choice", "forbidden"), /abort/i);
  await runtime.mountAll([{ id: "example", async setup(api) { assert.equal(await api.storage.get("choice"), "retained"); } }]);
  await runtime.mountAll([{ id: "failed", setup(api) { api.registerPage(page("uninstalled")); throw new Error("setup failed"); } }]);
  assert.equal(runtime.getPage("uninstalled"), undefined);
  await runtime.dispose();
});

test("scoped methods preserve their host receiver and cancellation with real session state", async () => {
  const state = createSessionState();
  const calls = [];
  const sessions = {
    mergeRecord: state.mergeRecord.bind(state),
    mergeRecords(records) { assert.equal(this, sessions); return records.map(record => this.mergeRecord(record)); },
  };
  const settings = { setState(id, value) { assert.equal(this, settings); calls.push(["settings", id, value]); } };
  const extensions = {
    invoke(id) { assert.equal(this, extensions); calls.push(["command", id]); return id; },
    hasCommand(id) { assert.equal(this, extensions); return id === "known"; },
  };
  const chat = { setInput(value) { assert.equal(this, chat); calls.push(["input", value]); } };
  const host = { root: {}, sessions, settings, extensions, chat,
    send(event) { assert.equal(this, host); calls.push(["send", event.type]); },
  };
  const runtime = createSidepanelUiRuntime({ host });
  let scoped;
  runtime.mount({ id: "receiver", mount(value) { scoped = value; return {}; } });
  scoped.sessions.mergeRecords([{ id: "owned", title: "Remembered" }]);
  assert.equal(state.getRecord("owned").title, "Remembered");
  scoped.settings.setState("custom", { text: "Saved" });
  assert.equal(scoped.extensions.invoke("known"), "known");
  assert.equal(scoped.extensions.hasCommand("known"), true);
  scoped.chat.setInput("draft");
  scoped.send({ type: "before" });
  assert.equal(calls.length, 4);
  await runtime.unmount("receiver");
  assert.throws(() => scoped.sessions.mergeRecords([{ id: "late" }]), /abort/i);
  scoped.settings.setState("late", {});
  scoped.extensions.invoke("late");
  scoped.chat.setInput("late");
  scoped.send({ type: "late" });
  assert.equal(state.getRecord("late"), null);
  assert.equal(calls.length, 4);
});

test("new pages own arbitrary snapshot state and restore legacy fields without host page switches", async () => {
  const { runtime } = fixture();
  let local = { selected: "new-record", filter: "keep spaces " };
  runtime.mount({ id: "weather", mount: () => ({ pages: [page("weather", {
    capture: () => local, restore: state => { local = state; },
  })] }) });
  const stored = normalizeWorkspaceView({ v: 2, page: "weather", state: runtime.capturePage("weather") });
  local = {};
  assert.equal(await runtime.restorePage(stored.page, stored.state), "restored");
  assert.deepEqual(local, { selected: "new-record", filter: "keep spaces " });
  const legacy = normalizeWorkspaceView({ v: 1, page: "weather", selected: "old-record" });
  assert.equal(await runtime.restorePage(legacy.page, legacy.state), "restored");
  assert.deepEqual(local, { selected: "old-record" });
  assert.equal(await runtime.restorePage("removed-package", {}), "failed");
  await runtime.dispose();
});

test("registration rejects duplicates atomically and snapshots page declarations", async () => {
  const { runtime, errors } = fixture();
  const original = page("first", { order: 20 });
  runtime.mount({ id: "one", mount: () => ({ pages: [original, page("second", { order: 10 })] }) });
  original.id = "mutated";
  original.title = "changed";
  assert.deepEqual(runtime.getPages().map(item => [item.id, item.title]), [["second", "second"], ["first", "first"]]);
  assert.throws(() => runtime.mount({ id: "one", mount: () => ({}) }), /Duplicate.*capability/);
  assert.equal(runtime.mount({ id: "two", mount: () => ({ pages: [page("new"), page("first")] }) }), false);
  assert.equal(runtime.getPage("new"), undefined);
  assert.match(errors[0].message, /Duplicate.*page.*first/);
  await runtime.dispose();
});

test("failed and late asynchronous mounts release ownership without removing a replacement", async () => {
  const { runtime, errors } = fixture();
  let aborted;
  let cleaned = 0;
  let events = 0;
  assert.equal(runtime.mount({ id: "failed", mount(host) {
    aborted = host.signal;
    host.onDispose(() => { cleaned += 1; });
    host.onEvent(() => { events += 1; });
    throw new Error("failed during assembly");
  } }), false);
  assert.equal(aborted.aborted, true);
  assert.equal(cleaned, 1);
  runtime.emit({ type: "accepted" });
  assert.equal(events, 0);
  let finish;
  let lateDisposed = 0;
  const mounting = runtime.mount({ id: "late", mount: () => new Promise(resolve => { finish = resolve; }) });
  await runtime.unmount("late");
  runtime.mount({ id: "late", mount: () => ({ pages: [page("replacement")] }) });
  finish({ pages: [page("stale")], dispose: () => { lateDisposed += 1; } });
  assert.equal(await mounting, false);
  assert.equal(lateDisposed, 1);
  assert.equal(runtime.getPage("stale"), undefined);
  assert.ok(runtime.getPage("replacement"));
  assert.equal(errors.length, 1);
  await runtime.dispose();
});

test("navigation aborts a pending restore and rejected callbacks cannot block sibling capabilities", async () => {
  const { runtime, errors } = fixture();
  let restoreSignal;
  let finish;
  let siblingEvents = 0;
  runtime.mount({ id: "async", mount: host => {
    host.onEvent(async () => { throw new Error("event failed"); });
    return { pages: [page("slow", {
      restore: (_state, context) => new Promise(resolve => { restoreSignal = context.signal; finish = resolve; }),
      activate: async () => { throw new Error("activate failed"); },
      capture: async () => { throw new Error("capture failed"); },
    })] };
  } });
  runtime.mount({ id: "sibling", mount: host => {
    host.onEvent(() => { siblingEvents += 1; });
    return { pages: [page("next"), page("disabled", { isEnabled: () => false })] };
  } });
  const restoring = runtime.restorePage("slow", {});
  runtime.activatePage("next");
  assert.equal(restoreSignal.aborted, true);
  finish();
  assert.equal(await restoring, "cancelled");
  assert.equal(runtime.activatePage("disabled"), false);
  runtime.emit({ type: "accepted" });
  runtime.activatePage("slow");
  assert.equal(runtime.capturePage("slow"), null);
  await tick();
  assert.equal(siblingEvents, 1);
  assert.deepEqual(errors.map(error => error.phase).sort(), ["activate", "capture", "event"]);
  await runtime.dispose();
});

test("overlay priority, settings groups and cleanup remain isolated through unmount", async () => {
  const { runtime, errors } = fixture();
  const closed = [];
  let finished = false;
  const classes = new Set();
  const retainedElement = { classList: { add: name => classes.add(name) } };
  runtime.mount({ id: "low", mount: () => ({
    overlays: [{ id: "low", priority: 1, close: () => { closed.push("low"); return true; }, blocksFocus: () => false }],
    settingsSections: [{ id: "custom", title: "Custom", element: {}, order: 2 }],
  }) });
  runtime.mount({ id: "high", mount: host => {
    host.onDispose(() => { throw new Error("first cleanup failed"); });
    host.onDispose(async () => { finished = true; });
    return { pages: [page("retained", { elements: [retainedElement] })], overlays: [{ id: "high", priority: 2, close: () => { closed.push("high"); return true; }, blocksFocus: () => true }] };
  } });
  assert.equal(runtime.hasBlockingOverlay(), true);
  assert.equal(runtime.closeTopmostOverlay(), true);
  assert.deepEqual(closed, ["high"]);
  runtime.activatePage("retained");
  await runtime.unmount("high");
  assert.equal(classes.has("hidden"), true, "the registry must hide retained DOM even when a package has no disposal hook");
  assert.equal(runtime.hasBlockingOverlay(), false);
  assert.equal(finished, true);
  assert.equal(errors[0].phase, "dispose");
  assert.equal(runtime.getSettingsSections()[0].id, "custom");
  await runtime.dispose();
  assert.deepEqual(runtime.getSettingsSections(), []);
});

test("unmount discards late responses and revokes user-visible effects", async () => {
  const effects = [];
  let resolveRequest;
  let scoped;
  const effect = () => effects.push("unexpected effect");
  const runtime = createSidepanelUiRuntime({ host: {
    root: {}, settings: { open: effect, close: effect, refresh: effect, setState: effect }, extensions: { notify: effect, invoke: effect },
    dialogs: { confirm: effect, choose: effect, requestText: effect },
    sessions: { mergeRecord: effect, mergeRecords: effect, mergeRuntime: effect, updateRuntime: effect, open: effect, export: effect },
    chat: { setInput: effect, showWelcome: effect, focus: effect, refresh: effect, scheduleRender: effect,
      appendNote: effect, clearInlineActions: effect, flashAction: effect, refreshReferences: effect, renderGoal: effect },
    request: () => new Promise(resolve => { resolveRequest = resolve; }),
    send: effect, showToast: effect, hideToast: effect, navigate: effect, notifyViewChange: effect,
  } });
  runtime.mount({ id: "delayed", mount(host) { scoped = host; return {}; } });
  const request = scoped.request("pending");
  await runtime.unmount("delayed");
  const rejected = assert.rejects(request, { name: "AbortError" });
  resolveRequest({ value: "too late" });
  await rejected;
  scoped.send({ type: "late" }); scoped.showToast("late"); scoped.hideToast(); scoped.notifyViewChange();
  scoped.settings.open(); scoped.settings.setState("anything", {}); scoped.extensions.notify({ type: "late" });
  scoped.extensions.invoke("other-package.write", {});
  assert.equal(await scoped.dialogs.confirm("late dialog"), false);
  assert.equal(await scoped.dialogs.choose(), null);
  assert.equal(await scoped.dialogs.requestText(), null);
  assert.equal(scoped.navigate("anything"), false);
  for (const method of ["mergeRecord", "mergeRecords", "mergeRuntime", "updateRuntime", "open", "export"]) {
    assert.throws(() => scoped.sessions[method]({}), { name: "AbortError" });
  }
  for (const method of ["setInput", "showWelcome", "focus", "refresh", "scheduleRender", "appendNote", "clearInlineActions", "flashAction", "refreshReferences", "renderGoal"]) {
    scoped.chat[method]();
  }
  assert.deepEqual(effects, []);
  await assert.rejects(scoped.request("after disposal"), { name: "AbortError" });
});

test("dialogs combine owner and caller cancellation and discard late answers", async () => {
  let scoped, lifetime, answer;
  const runtime = createSidepanelUiRuntime({ host: {
    root: {}, settings: {}, extensions: {}, dialogs: {
      confirm(_input, options) { lifetime = options.signal; return new Promise(resolve => { answer = resolve; }); },
    },
  } });
  runtime.mount({ id: "dialog", mount(host) { scoped = host; return {}; } });
  const caller = new AbortController();
  const confirmation = scoped.dialogs.confirm({ message: "Confirm", signal: caller.signal });
  caller.abort();
  assert.equal(lifetime.aborted, true);
  answer(true);
  assert.equal(await confirmation, false);
  const pending = scoped.dialogs.confirm("Pending");
  await runtime.unmount("dialog");
  assert.equal(lifetime.aborted, true);
  answer(true);
  assert.equal(await pending, false);
});

test("extension registrations cannot outlive their owner even with independent caller signals", async () => {
  const extensions = createWorkspaceExtensions();
  const runtime = createSidepanelUiRuntime({ host: { root: {}, settings: {}, extensions } });
  let scoped, observed = 0;
  runtime.mount({ id: "extensions", mount(host) { scoped = host; return {}; } });
  scoped.extensions.register({ commands: [{ id: "owned", run: () => "present" }] }, new AbortController().signal);
  scoped.extensions.onEvent(() => { observed += 1; }, new AbortController().signal);
  assert.equal(extensions.invoke("owned"), "present");
  extensions.notify({ type: "before" });
  await runtime.unmount("extensions");
  assert.equal(extensions.hasCommand("owned"), false);
  scoped.extensions.register({ commands: [{ id: "late", run: () => "unexpected" }] }, new AbortController().signal);
  scoped.extensions.onEvent(() => { observed += 100; }, new AbortController().signal);
  extensions.notify({ type: "after" });
  assert.equal(extensions.hasCommand("late"), false);
  assert.equal(observed, 1);
});

test("session navigation inherits both capability and caller cancellation", async () => {
  let scoped;
  const received = [];
  const runtime = createSidepanelUiRuntime({ host: { root: {}, settings: {}, extensions: {}, sessions: {
    async open(id, options) { received.push({ id, ...options }); },
  } } });
  runtime.mount({ id: "navigation", mount(host) { scoped = host; return {}; } });
  const caller = new AbortController();
  await scoped.sessions.open("first", { source: "user", signal: caller.signal });
  await scoped.sessions.open("second");
  caller.abort();
  assert.equal(received[0].signal.aborted, true);
  assert.equal(received[1].signal.aborted, false);
  assert.equal(received[0].source, "user");
  await runtime.unmount("navigation");
  assert.equal(received[1].signal.aborted, true);
});

test("product settings inherit the UI lifetime and reject writes after unload", async () => {
  let qz, productSignal;
  const host = { root: {}, settings: {}, extensions: {},
    providers: { createSettings(input) { productSignal = input.signal; return {}; } },
  };
  const runtime = createSidepanelUiRuntime({ host });
  await runtime.mountAll([{ id: "product", setup(api) { qz = api; } }]);
  qz.providers.createSettings({});
  await runtime.unmount("product");
  assert.equal(productSignal.aborted, true);
  assert.throws(() => qz.providers.createSettings({}), { name: "AbortError" });
});
