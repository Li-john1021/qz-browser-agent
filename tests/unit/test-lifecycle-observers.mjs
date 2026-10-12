import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleObservers } from "../../src/background/lifecycle-observers.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
const event = { type: "message_start", runId: "run-a", epoch: 3, eventSeq: 7,
  message: { role: "user", _origin: "user", content: "private text", apiKey: "secret" }, args: { token: "secret" } };

test("observers see immutable metadata with identity and phase, never message bodies or credentials", async () => {
  const received = [];
  const observers = createLifecycleObservers([{ id: "summary", onEvent: value => { received.push(value); } }]);
  observers.emit("session-a", event);
  observers.emit("session-a", { ...event, type: "agent_end" }, "committed");
  await observers.flush();
  assert.deepEqual(received.map(({ type, phase, sessionId, runId, epoch, eventSeq, message }) => ({ type, phase, sessionId, runId, epoch, eventSeq, message })), [
    { type: "message_start", phase: "emitted", sessionId: "session-a", runId: "run-a", epoch: 3, eventSeq: 7, message: { role: "user", _origin: "user" } },
    { type: "agent_end", phase: "committed", sessionId: "session-a", runId: "run-a", epoch: 3, eventSeq: 7, message: { role: "user", _origin: "user" } },
  ]);
  assert.equal(JSON.stringify(received).includes("secret"), false);
  assert.equal(JSON.stringify(received).includes("private text"), false);
  assert.throws(() => { received[0].message.role = "assistant"; }, TypeError);
  assert.equal(event.message.role, "user");
});

test("slow observers do not block producers or other observers; each observer preserves event order", async () => {
  const gate = deferred();
  const fastDone = deferred();
  const slow = [], fast = [];
  const observers = createLifecycleObservers([
    { id: "slow", onEvent: async value => { slow.push(value.eventSeq); await gate.promise; } },
    { id: "fast", onEvent: value => { fast.push(value.eventSeq); if (fast.length === 2) fastDone.resolve(); } },
  ]);
  assert.equal(observers.emit("s", { ...event, eventSeq: 1 }), undefined);
  observers.emit("s", { ...event, eventSeq: 2 });
  await fastDone.promise;
  assert.deepEqual(fast, [1, 2]);
  assert.deepEqual(slow, [1]);
  gate.resolve();
  await observers.flush();
  assert.deepEqual(slow, [1, 2]);
});

test("capacity bounds queued and active work and reports overflow once per burst", async () => {
  const gate = deferred();
  const received = [], diagnostics = [];
  const observers = createLifecycleObservers([{ id: "bounded", capacity: 2, onEvent: async value => {
    received.push(value.eventSeq); await gate.promise;
  } }], { onDiagnostic: item => diagnostics.push(item) });
  for (let n = 1; n <= 10; n++) observers.emit("s", { ...event, eventSeq: n });
  gate.resolve();
  await observers.flush();
  assert.deepEqual(received, [1, 2]);
  assert.deepEqual(diagnostics, [{ observerId: "bounded", code: "OBSERVER_OVERFLOW" }]);
});

test("timeout aborts and disables an uncooperative observer so new events cannot accumulate promises", async () => {
  const diagnostics = [];
  let signal, calls = 0;
  const observers = createLifecycleObservers([{ id: "hung", timeoutMs: 15, onEvent: (_event, inputSignal) => {
    calls++; signal = inputSignal; return new Promise(() => {});
  } }], { onDiagnostic: item => diagnostics.push(item) });
  observers.emit("s", event);
  await observers.flush();
  observers.emit("s", event);
  await observers.flush();
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.deepEqual(diagnostics, [{ observerId: "hung", code: "OBSERVER_TIMEOUT" }]);
});

test("callback and diagnostic failures are isolated; disposal cancels pending work", async () => {
  let attempts = 0;
  const observers = createLifecycleObservers([{ id: "failure", onEvent: () => {
    attempts++; throw new Error("failure");
  } }], { onDiagnostic: () => { throw new Error("diagnostic failure"); } });
  observers.emit("s", event);
  observers.emit("s", event);
  await observers.flush();
  assert.equal(attempts, 2);

  const started = deferred();
  let signal, called = 0;
  const cancellable = createLifecycleObservers([{ id: "dispose", onEvent: (_event, value) => {
    called++; signal = value; started.resolve(); return new Promise(() => {});
  } }]);
  cancellable.emit("s", event);
  cancellable.emit("s", event);
  await started.promise;
  cancellable.dispose();
  await cancellable.flush();
  assert.equal(signal.aborted, true);
  assert.equal(called, 1);
});

test("reentrant emission drains exactly once and predicates can select durable events", async () => {
  const phases = [];
  const observers = createLifecycleObservers([{ id: "durable", accepts: value => value.phase === "committed", onEvent: value => {
    phases.push(value.eventSeq);
    if (value.eventSeq === 1) queueMicrotask(() => observers.emit("s", { ...event, eventSeq: 2 }, "committed"));
  } }]);
  observers.emit("s", { ...event, eventSeq: 0 });
  observers.emit("s", { ...event, eventSeq: 1 }, "committed");
  await observers.flush();
  assert.deepEqual(phases, [1, 2]);
});

test("the documented completion example records only committed terminal events", async () => {
  const { completionObserver } = await import("../fixtures/capabilities/example/context-and-observer.js");
  const calls = [];
  const observers = createLifecycleObservers([completionObserver(async (...args) => { calls.push(args); })]);
  observers.emit("s", { type: "agent_end", runId: "r" });
  observers.emit("s", { type: "message_start", runId: "r" }, "committed");
  observers.emit("s", { type: "agent_end", runId: "r" }, "committed");
  await observers.flush();
  assert.deepEqual(calls, [["s", "r"]]);
});
