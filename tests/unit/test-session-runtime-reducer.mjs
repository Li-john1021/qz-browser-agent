import assert from "node:assert/strict";
import {
  SESSION_STATUS,
  createInitialSessionRuntime,
  recoverPersistedRuntime,
  reduceSessionRuntime,
  reduceSessionRuntimePatch,
} from "../../src/background/session/runtime-reducer.js";

const initial = createInitialSessionRuntime("session-a", "2026-07-12 10:00:00");
assert.equal(initial.status, SESSION_STATUS.IDLE);
assert.equal(initial.running, false);
assert.deepEqual(initial.pendingSteeringMessages, []);
assert.deepEqual(initial.pendingSteerings, []);

const pending = reduceSessionRuntime(initial, {
  type: "session_pending",
  startedAt: "2026-07-12 10:00:01",
}, { now: "2026-07-12 10:00:01" });
assert.equal(pending.status, SESSION_STATUS.PENDING);
assert.equal(pending.pendingStart, true);
assert.equal(pending.running, true);

const running = reduceSessionRuntime(pending, {
  type: "agent_start",
  runId: "run-1",
}, { now: "2026-07-12 10:00:02" });
assert.equal(running.status, SESSION_STATUS.RUNNING);
assert.equal(running.pendingStart, false);
assert.equal(running.runId, "run-1");

const runningWithUsage = reduceSessionRuntime({
  ...running,
  contextUsage: { input_tokens: 12345 },
  contextWindow: 262144,
  inputTokensEstimate: 12345,
}, {
  type: "agent_start",
  runId: "run-2",
}, { now: "2026-07-12 10:00:02" });
assert.equal(runningWithUsage.inputTokensEstimate, 12345, "agent_start should not blank the previous context reading");
assert.equal(runningWithUsage.contextWindow, 262144);

const tool = { name: "run_script", toolCallId: "call-1", startedAt: "2026-07-12 10:00:03" };
const withTool = reduceSessionRuntime(running, {
  type: "tool_execution_start",
  toolName: "run_script",
}, { now: "2026-07-12 10:00:03", currentTool: tool });
assert.deepEqual(withTool.currentTool, tool);
assert.equal(withTool.currentToolName, "run_script");

const waiting = reduceSessionRuntime(withTool, {
  type: "waiting_for_user",
  runId: "run-1",
  waitId: "wait-1",
  message: "请完成登录",
  form: { title: "等待登录" },
}, { now: "2026-07-12 10:00:04" });
assert.equal(waiting.status, SESSION_STATUS.WAITING_USER);
assert.equal(waiting.waitId, "wait-1");

const resumed = reduceSessionRuntime(waiting, {
  type: "user_wait_resolved",
  reason: "user",
}, { now: "2026-07-12 10:00:05" });
assert.equal(resumed.status, SESSION_STATUS.RUNNING);
assert.equal(resumed.waitId, "");

const failed = reduceSessionRuntime(resumed, {
  type: "error",
  runId: "run-1",
  message: "provider failed",
}, { now: "2026-07-12 10:00:06" });
const ended = reduceSessionRuntime(failed, {
  type: "agent_end",
  runId: "run-1",
}, { now: "2026-07-12 10:00:07" });
assert.equal(ended.status, SESSION_STATUS.ERROR, "agent_end must not overwrite an earlier terminal error");
assert.equal(ended.reason, "provider failed");
assert.equal(ended.running, false);

const queuePatch = reduceSessionRuntimePatch(running, {
  type: "queue_update",
  pendingFollowUpMessages: [{ role: "user", content: "next" }],
  pendingSteeringMessages: [{ role: "user", content: "guide now" }],
}, { now: "2026-07-12 10:00:08" });
assert.deepEqual(queuePatch.pendingFollowUpMessages, [{ role: "user", content: "next" }]);
assert.deepEqual(queuePatch.pendingSteeringMessages, [{ role: "user", content: "guide now" }]);
assert.equal(Object.prototype.hasOwnProperty.call(queuePatch, "ownedTabIds"), false, "event patches must not touch unrelated runtime fields");

const queued = reduceSessionRuntime(running, {
  type: "queue_update",
  pendingFollowUpMessages: [
    { role: "user", content: "first", clientMessageId: "queued-1" },
    { role: "user", content: "second", clientMessageId: "queued-2" },
  ],
  pendingSteeringMessages: [
    { role: "user", content: "guide", clientMessageId: "steering-1" },
  ],
}, { now: "2026-07-12 10:00:08" });
const abortedWithQueue = reduceSessionRuntime(queued, {
  type: "session_aborted",
  runId: "run-1",
}, { now: "2026-07-12 10:00:09" });
assert.deepEqual(
  abortedWithQueue.pendingFollowUpMessages.map(message => message.clientMessageId),
  ["queued-1", "queued-2"],
  "aborting a run must preserve accepted follow-up messages",
);
assert.deepEqual(
  abortedWithQueue.pendingSteeringMessages.map(message => message.clientMessageId),
  ["steering-1"],
  "aborting a run must preserve accepted steering messages",
);
const resetWithQueues = reduceSessionRuntime(abortedWithQueue, {
  type: "reset",
}, { now: "2026-07-12 10:00:10" });
assert.deepEqual(resetWithQueues.pendingFollowUpMessages, []);
assert.deepEqual(resetWithQueues.pendingSteeringMessages, []);

const persisted = {
  ...running,
  workingTab: { id: 9, url: "https://example.com" },
  ownedTabIds: [9],
  goal: { objective: "finish" },
};
const recovered = recoverPersistedRuntime(persisted, "2026-07-12 10:10:00");
assert.equal(recovered.status, SESSION_STATUS.INTERRUPTED);
assert.equal(recovered.running, false);
assert.equal(recovered.reason, "service_worker_restarted");
assert.deepEqual(recovered.ownedTabIds, [9]);
assert.equal(recovered.goal.objective, "finish");
const lateEndAfterRecovery = reduceSessionRuntime(recovered, {
  type: "agent_end",
  runId: recovered.runId,
}, { now: "2026-07-12 10:10:01" });
assert.equal(lateEndAfterRecovery.status, SESSION_STATUS.INTERRUPTED, "a late terminal event must not revive an interrupted run as completed");
assert.equal(lateEndAfterRecovery.reason, "service_worker_restarted");

assert.equal(reduceSessionRuntimePatch(running, { type: "message_update" }), null);
assert.equal(running.status, SESSION_STATUS.RUNNING, "the reducer must not mutate its input");

console.log("session runtime reducer tests passed");
