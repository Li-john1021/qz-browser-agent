import assert from "node:assert/strict";
import test from "node:test";
import { createChatRunController } from "../../src/sidepanel/features/chat/chat-run-controller.js";

function fixture(t) {
  const noop = () => {};
  const sent = [];
  const tracked = [];
  const reconciles = [];
  const classes = new Set(["hidden"]);
  const runtime = { status: "running", running: true, runId: "run-1" };
  let resolve;
  let reject;
  const response = new Promise((res, rej) => { resolve = res; reject = rej; });
  const controller = createChatRunController({
    messagesEl: {},
    statusBar: { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } },
    statusText: { textContent: "" },
    transcript: { getCurrentTranscript: () => [], hideAssistantActions: noop, scheduleRender: noop, render: noop },
    scroll: { updateSafeArea: noop, settleAfterDockLayout: noop, shouldFollowTail: () => false },
    queue: { render: noop },
    getSessionId: () => "session-1", isCurrentSession: id => id === "session-1", isChatActive: () => true,
    getRuntime: () => runtime, isRuntimeRunning: value => value.running,
    trackBackgroundRun: event => { tracked.push(event); Object.assign(runtime, event.runtime); },
    send: event => sent.push(event), request: () => response,
    scheduleTranscriptReconcile: (...args) => reconciles.push(args),
  });
  controller.start("run-1", { requireConversation: false });
  t.after(() => controller.finish());
  return { controller, sent, tracked, reconciles, runtime, resolve, reject };
}

test("stop retains the existing optimistic UI and accepts the final Background reply", async t => {
  const f = fixture(t);
  assert.equal(f.controller.stop(), true);
  assert.equal(f.controller.getStatus(), "idle");
  assert.equal(f.runtime.status, "aborted");
  assert.equal(f.controller.isBlocked("run-1"), true);
  f.resolve({ sessionId: "session-1", runId: "run-1", status: "aborted", runtime: { ...f.runtime, status: "aborted", running: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getStatus(), "idle");
  assert.equal(f.runtime.status, "aborted");
  assert.deepEqual(f.reconciles, []);
});

test("a failed stop preserves the existing full transcript reconciliation path", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(t);
  f.controller.stop();
  f.reject(new Error("stop_session timed out"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.reconciles, [["session-1", { delay: 250, force: true }]]);
  assert.equal(f.controller.getStatus(), "idle");
});
