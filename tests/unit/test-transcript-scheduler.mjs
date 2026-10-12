import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptScheduler } from "../../src/sidepanel/features/chat/transcript/scheduler.js";

// Keep cancelled callbacks callable: browsers may already have queued their delivery.
function harness(run, { idle = true, cancelIdle = true, observer = true } = {}) {
  const saved = new Map();
  function stub(object, key, value) {
    saved.set([object, key], Object.getOwnPropertyDescriptor(object, key));
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
  }
  let now = 100;
  let next = 0;
  const jobs = [];
  const observers = [];
  const calls = [];
  const trace = [];
  const state = { active: "a", booting: false, delay: null, input: false };
  function queue(kind, callback, delay) {
    const job = { id: ++next, kind, callback, delay, cancelled: false, fired: false };
    jobs.push(job);
    return job.id;
  }
  function cancel(id) { const job = jobs.find(item => item.id === id); if (job) job.cancelled = true; }
  const host = {};
  if (idle) {
    host.requestIdleCallback = (callback, options) => queue("idle", callback, options.timeout);
    if (cancelIdle) host.cancelIdleCallback = cancel;
  }
  if (observer) host.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  stub(globalThis, "window", host);
  stub(globalThis, "navigator", { scheduling: { isInputPending: options => {
    assert.deepEqual(options, { includeContinuous: true });
    if (state.input instanceof Error) throw state.input;
    return state.input;
  } } });
  stub(globalThis, "setTimeout", (callback, delay) => queue("timeout", callback, delay));
  stub(globalThis, "clearTimeout", cancel);
  stub(globalThis, "requestAnimationFrame", callback => queue("frame", callback));
  stub(globalThis, "cancelAnimationFrame", cancel);
  stub(Date, "now", () => now);
  const options = {
    workspaceRoot: { hasAttribute: () => state.booting },
    isActive: id => state.active === "all" || id === state.active,
    render: id => calls.push(["render", id]),
    backfill: id => calls.push(["backfill", id]),
    backfillDelay: () => state.delay,
    trace: (...args) => trace.push(args),
  };
  const scheduler = createTranscriptScheduler(options);
  const pending = kind => jobs.filter(job => !job.cancelled && !job.fired && (!kind || job.kind === kind));
  const fire = job => { assert.ok(job, "expected a queued callback"); job.fired = true; job.callback(); };
  try {
    run({ scheduler, state, calls, trace, jobs, observers, options, pending, fire, advance: ms => { now += ms; } });
  } finally {
    scheduler.cancel();
    for (const [[object, key], descriptor] of [...saved].reverse()) {
      if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
    }
  }
}

test("render coalesces to the earliest deadline and cancelled timers cannot enqueue old frames", () => harness(h => {
  h.scheduler.requestRender("a", 120);
  const old = h.pending("timeout")[0];
  h.scheduler.requestRender("a", 150);
  assert.equal(h.jobs.length, 1);
  h.scheduler.requestRender("a", 48);
  assert.equal(old.cancelled, true);
  h.fire(old);
  assert.equal(h.pending("frame").length, 0);
  assert.equal(h.pending("timeout")[0].delay, 48);
  h.fire(h.pending("timeout")[0]);
  h.scheduler.requestRender("a", 120);
  assert.equal(h.pending("timeout").length, 0, "a ready frame keeps its earlier deadline");
  h.fire(h.pending("frame")[0]);
  assert.deepEqual(h.calls, [["render", "a"]]);
  assert.equal(h.trace.filter(([event]) => event === "ui_render_timer_set").length, 2);
}));

test("an urgent render replaces an already queued frame without old callbacks claiming the replacement", () => harness(h => {
  h.scheduler.requestRender("a", 120);
  // The timeout may arrive early in a controlled host; its deadline is still retained by the frame.
  h.fire(h.pending("timeout")[0]);
  const old = h.pending("frame")[0];
  h.scheduler.requestRender("a", 0);
  assert.equal(old.cancelled, true);
  h.fire(old);
  assert.deepEqual(h.calls, []);
  assert.equal(h.pending("frame").length, 1);
  h.fire(h.pending("frame")[0]);
  assert.deepEqual(h.calls, [["render", "a"]]);
}));

test("input yielding is bounded at 96 ms and completed frames cannot run twice", () => harness(h => {
  h.state.input = true;
  h.scheduler.requestRender("a", 0);
  const first = h.pending("frame")[0];
  h.fire(first);
  h.advance(95);
  h.fire(h.pending("frame")[0]);
  assert.deepEqual(h.calls, []);
  h.advance(1);
  h.fire(h.pending("frame")[0]);
  h.fire(first);
  assert.deepEqual(h.calls, [["render", "a"]]);
  assert.deepEqual(h.trace.at(-1), ["ui_render_timer_fire", "a", { delay: 0, inputYields: 2 }]);
}));

test("missing or throwing input detection does not suppress rendering", () => harness(h => {
  for (const input of [new Error("unsupported"), false]) {
    h.state.input = input;
    if (input === false) delete navigator.scheduling;
    h.scheduler.requestRender("a", 0);
    h.fire(h.pending("frame")[0]);
  }
  assert.equal(h.calls.length, 2);
}));

for (const phase of ["timeout", "frame", "idle", "observer", "reveal"]) {
  test(`cancel revokes ${phase} callbacks before a new task for the same session`, () => harness(h => {
    const backfill = ["idle", "observer", "reveal"].includes(phase);
    let old;
    if (backfill) {
      h.state.booting = phase !== "idle";
      h.scheduler.requestBackfill("a");
      if (phase === "observer") old = { callback: () => h.observers[0].callback() };
      else if (phase === "reveal") {
        h.state.booting = false; h.observers[0].callback(); old = h.pending("timeout")[0];
      } else old = h.pending("idle")[0];
    } else {
      h.scheduler.requestRender("a", phase === "timeout" ? 120 : 0);
      old = h.pending(phase)[0];
    }
    h.scheduler.cancel("a");
    assert.equal(h.pending().length, 0);
    assert.ok(h.observers.every(observer => observer.disconnected));
    h.state.booting = false;
    if (backfill) h.scheduler.requestBackfill("a"); else h.scheduler.requestRender("a", 0);
    h.fire(old);
    assert.deepEqual(h.calls, []);
    assert.equal(h.pending().length, 1, "old delivery must leave the replacement task intact");
    h.fire(h.pending()[0]);
    assert.deepEqual(h.calls, [[backfill ? "backfill" : "render", "a"]]);
  }));
}

test("session cancellation preserves other sessions, while reset revokes both kinds everywhere", () => harness(h => {
  h.state.active = "all";
  for (const id of ["a", "b"]) { h.scheduler.requestRender(id, 0); h.scheduler.requestBackfill(id); }
  const old = [...h.jobs];
  h.scheduler.cancel("a");
  assert.equal(h.pending().length, 2);
  h.scheduler.cancel();
  assert.equal(h.pending().length, 0);
  for (const job of old) h.fire(job);
  assert.deepEqual(h.calls, []);
  h.scheduler.requestRender("a", 0); h.fire(h.pending()[0]);
  assert.deepEqual(h.calls, [["render", "a"]]);
}));

test("single-kind cancellation preserves the other pending task", () => harness(h => {
  h.scheduler.requestRender("a", 0); h.scheduler.requestBackfill("a");
  h.scheduler.cancel("a", "render");
  h.fire(h.pending("idle")[0]);
  h.scheduler.requestRender("a", 0); h.scheduler.requestBackfill("a");
  h.scheduler.cancel(undefined, "backfill");
  h.fire(h.pending("frame")[0]);
  assert.deepEqual(h.calls, [["backfill", "a"], ["render", "a"]]);
}));

for (const phase of ["timeout", "frame", "idle", "observer", "reveal"]) {
  test(`session switches suppress ${phase} work even before explicit cleanup`, () => harness(h => {
    h.state.booting = phase === "observer" || phase === "reveal";
    if (["timeout", "frame"].includes(phase)) h.scheduler.requestRender("a", phase === "timeout" ? 120 : 0);
    else h.scheduler.requestBackfill("a");
    if (phase === "reveal") { h.state.booting = false; h.observers[0].callback(); }
    h.state.active = "b"; h.state.booting = false;
    if (phase === "observer") h.observers[0].callback(); else h.fire(h.pending()[0]);
    assert.equal(h.pending().length, 0);
    assert.deepEqual(h.calls, []);
    h.scheduler.requestRender("a", 0); h.scheduler.requestBackfill("a");
    assert.equal(h.pending().length, 0, "hidden sessions cannot queue visible work");
  }));
}

test("backfill waits for reveal plus 80 ms, then reads the current delay policy", () => harness(h => {
  h.state.booting = true;
  h.scheduler.requestBackfill("a"); h.scheduler.requestBackfill("a");
  assert.equal(h.observers.length, 1);
  const observer = h.observers[0];
  observer.callback();
  assert.equal(h.pending().length, 0);
  h.state.booting = false; observer.callback();
  assert.equal(observer.disconnected, true);
  assert.equal(h.pending("timeout")[0].delay, 80);
  observer.callback();
  assert.equal(h.pending().length, 1, "queued observer deliveries cannot duplicate the reveal timer");
  h.state.delay = 1000;
  h.fire(h.pending("timeout")[0]);
  assert.equal(h.pending("timeout")[0].delay, 1000);
  h.fire(h.pending("timeout")[0]);
  assert.deepEqual(h.calls, [["backfill", "a"]]);
}));

test("idle backfill preserves the 700 ms timeout and can schedule its next batch", () => harness(h => {
  h.options.backfill = id => { h.calls.push(["backfill", id]); h.scheduler.requestBackfill(id); };
  h.scheduler.requestBackfill("a"); h.scheduler.requestBackfill("a");
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending("idle")[0].delay, 700);
  h.fire(h.pending("idle")[0]);
  assert.equal(h.pending("idle").length, 1);
  assert.deepEqual(h.calls, [["backfill", "a"]]);
}));

test("hosts without idle or observers retain timeout backfill", () => harness(h => {
  h.state.booting = true;
  h.scheduler.requestBackfill("a");
  assert.equal(h.pending("timeout")[0].delay, 80);
  h.fire(h.pending("timeout")[0]);
  assert.deepEqual(h.calls, [["backfill", "a"]]);
}, { idle: false, observer: false }));

test("missing idle cancellation still revokes old work without consuming a replacement", () => harness(h => {
  h.scheduler.requestBackfill("a");
  const old = h.pending("idle")[0];
  h.scheduler.cancel("a");
  h.scheduler.requestBackfill("a");
  const replacement = h.pending("idle").at(-1);
  h.fire(old);
  assert.deepEqual(h.calls, []);
  h.fire(replacement);
  assert.deepEqual(h.calls, [["backfill", "a"]]);
}, { cancelIdle: false }));

test("failed work releases its slot before invoking recovery", () => harness(h => {
  h.options.backfill = () => { throw new Error("batch failed"); };
  h.scheduler.requestBackfill("a");
  assert.throws(() => h.fire(h.pending("idle")[0]), /batch failed/);
  h.options.backfill = id => h.calls.push(["recovered", id]);
  h.scheduler.requestBackfill("a"); h.fire(h.pending("idle")[0]);
  assert.deepEqual(h.calls, [["recovered", "a"]]);
}));
