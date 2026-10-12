import assert from "node:assert/strict";
import { createAutomationRepository } from "../../src/background/automation/repository.js";
import {
  AUTOMATION_SCHEDULER_ALARM,
  createAutomationRuntime,
} from "../../src/background/automation/runtime.js";

function createStorage() {
  const values = {};
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: structuredClone(values[key]) };
      return structuredClone(values);
    },
    async set(patch) {
      Object.assign(values, structuredClone(patch));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete values[item];
    },
  };
}

function createHarness({
  createSession = null,
  launchSession = null,
  stopSession = null,
  removeSession = null,
  ready = async () => {},
  clock = () => Date.now(),
  sessionRecords = {},
  getSessionMetadata = null,
  getConversation = null,
  getTranscript = null,
  createNotification = null,
  logger = console,
} = {}) {
  const repository = createAutomationRepository({ storage: createStorage() });
  const runtimes = new Map();
  const sessions = [];
  const stopped = [];
  const removed = [];
  const activated = [];
  const emitted = [];
  const notifications = [];
  const clearedNotifications = [];
  let sessionSequence = 0;
  let runtime;
  runtime = createAutomationRuntime({
    repository,
    sessions: {
      getRuntime: sessionId => runtimes.get(sessionId) || {},
      async getMetadata(sessionId) {
        if (getSessionMetadata) return getSessionMetadata(sessionId, { sessions, runtimes });
        return sessions.find(session => session.id === sessionId) || null;
      },
      async listRecords() { return sessionRecords; },
      async create({ automation, run, prompt }) {
        if (createSession) return createSession({ automation, run, prompt, runtimes, sessions });
        const session = {
          id: `auto-session-${++sessionSequence}`,
          automationId: automation.id,
          automationRunId: run.id,
          prompt,
        };
        sessions.push(session);
        runtimes.set(session.id, { status: "pending", running: true });
        return session;
      },
      launch(sessionId) {
        if (launchSession) return launchSession(sessionId, { runtimes, sessions });
        runtimes.set(sessionId, { status: "running", running: true });
        return true;
      },
      async stop(sessionId) {
        stopped.push(sessionId);
        runtimes.set(sessionId, { status: "aborted", running: false });
        if (stopSession) await stopSession({ sessionId, runtime, runtimes });
      },
      async remove(sessionId) {
        removed.push(sessionId);
        runtimes.delete(sessionId);
        if (removeSession) await removeSession({ sessionId, runtime, runtimes });
      },
      async getConversation(sessionId) {
        return getConversation ? getConversation(sessionId) : [];
      },
      async getTranscript(sessionId) {
        return getTranscript ? getTranscript(sessionId) : [];
      },
      async activateWorkingTab(sessionId, options) { activated.push({ sessionId, options }); },
      async shouldSuppressNotification() { return false; },
    },
    alarms: {
      async get() { return { name: AUTOMATION_SCHEDULER_ALARM }; },
      async create() {},
    },
    notifications: {
      iconUrl: "chrome-extension://test/icon.png",
      async create(id, options) {
        notifications.push({ id, options });
        if (createNotification) return createNotification(id, options);
        return id;
      },
      async clear(id) { clearedNotifications.push(id); },
    },
    emit: event => emitted.push(event),
    ready,
    clock,
    logger,
  });
  return {
    runtime,
    repository,
    runtimes,
    sessions,
    stopped,
    removed,
    activated,
    emitted,
    notifications,
    clearedNotifications,
  };
}

async function saveDefinition(harness, overrides = {}) {
  return harness.repository.saveDefinition({
    title: "并发测试",
    instruction: "执行一次测试任务",
    schedule: { type: "daily", time: "09:00" },
    notifyPolicy: "always",
    enabled: true,
    ...overrides,
  });
}

function withTimeout(promise, timeoutMs = 250) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntil(predicate, message, timeoutMs = 250) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

{
  const harness = createHarness();
  const automation = await saveDefinition(harness);
  const results = await Promise.allSettled([
    harness.runtime.run(automation.id),
    harness.runtime.run(automation.id),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "concurrent manual runs must create one run");
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(harness.sessions.length, 1);
  assert.equal((await harness.repository.listRuns(automation.id, { limit: 20 })).length, 1);

  const run = (await harness.repository.listRuns(automation.id, { limit: 20 }))[0];
  harness.runtimes.set(run.sessionId, { status: "completed", running: false });
  await harness.runtime.syncSessionOutcome(run.sessionId);
  await harness.runtime.syncSessionOutcome(run.sessionId);
  const completed = await harness.repository.getRun(run.id);
  assert.equal(completed.status, "completed");
  assert.equal(harness.notifications.length, 1, "duplicate terminal events must not notify twice");
  assert.equal((await harness.repository.listDefinitions())[0].runningRunId, "");

  assert.equal(await harness.runtime.handleNotificationClick(harness.notifications[0].id), true);
  assert.deepEqual(harness.activated, [{ sessionId: run.sessionId, options: { focusWindow: true } }]);
  assert.deepEqual(harness.clearedNotifications, [harness.notifications[0].id]);
}

{
  const harness = createHarness({ ready: () => new Promise(() => {}) });
  assert.equal(
    await withTimeout(harness.runtime.syncSessionOutcome("ordinary-session"), 50),
    false,
    "an ordinary Session must return before entering the Automation operation queue",
  );
}

{
  const harness = createHarness({ createNotification: () => new Promise(() => {}) });
  const automation = await saveDefinition(harness);
  const { run } = await harness.runtime.run(automation.id);
  harness.runtimes.set(run.sessionId, { status: "completed", running: false });

  assert.equal(await withTimeout(harness.runtime.syncSessionOutcome(run.sessionId), 50), true);
  await withTimeout(harness.runtime.flush(), 50);
  await waitUntil(() => harness.notifications.length === 1, "detached notification did not start");
  assert.equal((await harness.repository.getRun(run.id)).status, "completed");
  assert.equal((await harness.repository.listDefinitions())[0].runningRunId, "");
  assert.equal(
    harness.runtime.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }),
    true,
    "a never-settling notification must not poison later scheduler ticks",
  );
  await withTimeout(harness.runtime.flush(), 50);
}

{
  const harness = createHarness();
  const automation = await saveDefinition(harness, { notifyPolicy: "silent" });
  const { run } = await harness.runtime.run(automation.id);
  harness.runtimes.set(run.sessionId, { status: "completed", running: false });

  await harness.runtime.start();
  await withTimeout(harness.runtime.flush(), 50);
  assert.equal(
    (await harness.repository.getRun(run.id)).status,
    "completed",
    "boot reconciliation must recover an Automation run left active after Session completion",
  );
  assert.equal((await harness.repository.listDefinitions())[0].runningRunId, "");
}

for (const testCase of [
  { sessionStatus: "completed", expected: "completed", reason: "" },
  { sessionStatus: "error", expected: "error", reason: "provider failed" },
  { sessionStatus: "aborted", expected: "aborted", reason: "stopped" },
  { sessionStatus: "cancelled", expected: "aborted", reason: "cancelled_before_start" },
  { sessionStatus: "interrupted", expected: "interrupted", reason: "service_worker_restarted" },
  { sessionStatus: "idle", expected: "interrupted", reason: "" },
]) {
  const harness = createHarness();
  const automation = await saveDefinition(harness);
  const { run } = await harness.runtime.run(automation.id);
  harness.runtimes.set(run.sessionId, {
    status: testCase.sessionStatus,
    running: false,
    reason: testCase.reason,
  });
  assert.equal(await harness.runtime.syncSessionOutcome(run.sessionId), true);
  const settled = await harness.repository.getRun(run.id);
  assert.equal(settled.status, testCase.expected, `${testCase.sessionStatus} outcome`);
  if (testCase.reason) assert.equal(settled.error, testCase.reason);
  await harness.runtime.flush();
}

{
  const harness = createHarness({
    getTranscript: async () => [{ type: "error", text: "LLM API 503: provider unavailable" }],
  });
  const automation = await saveDefinition(harness);
  const { run } = await harness.runtime.run(automation.id);
  harness.runtimes.set(run.sessionId, { status: "completed", running: false });
  assert.equal(await harness.runtime.syncSessionOutcome(run.sessionId), true);
  const settled = await harness.repository.getRun(run.id);
  assert.equal(settled.status, "error", "a completed Session retains transcript-level LLM failure detection");
  assert.match(settled.error, /provider unavailable/);
  await harness.runtime.flush();
}

{
  const sessionRecords = {};
  const harness = createHarness({ sessionRecords });
  const automation = await saveDefinition(harness);
  const { run } = await harness.runtime.run(automation.id);
  sessionRecords[run.sessionId] = {
    id: run.sessionId,
    listSummary: { lastText: "已检查 128 个商品，发现 3 个价格变化。" },
  };
  harness.runtimes.set(run.sessionId, { status: "completed", running: false });
  await harness.runtime.syncSessionOutcome(run.sessionId);

  const listed = await harness.runtime.list({ runLimit: 5 });
  assert.equal(listed.runs[automation.id][0].lastMessage, "已检查 128 个商品，发现 3 个价格变化。");
  const runList = await harness.runtime.listRuns({ automationId: automation.id, limit: 5 });
  assert.equal(runList.runs[0].lastMessage, "已检查 128 个商品，发现 3 个价格变化。");
  assert.equal((await harness.repository.getRun(run.id)).lastMessage, undefined, "last message is a list projection, not duplicated run state");
}

{
  let createAttempts = 0;
  const harness = createHarness({
    createSession: async ({ automation, run, prompt, runtimes, sessions }) => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("session create unavailable");
      const session = { id: "recovered-session", automationId: automation.id, automationRunId: run.id, prompt };
      sessions.push(session);
      runtimes.set(session.id, { status: "pending", running: true });
      return session;
    },
  });
  const automation = await saveDefinition(harness);
  await assert.rejects(harness.runtime.run(automation.id), /session create unavailable/);
  const failed = await harness.repository.listRuns(automation.id, { limit: 20 });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, "error");
  assert.equal((await harness.repository.listDefinitions())[0].runningRunId, "");

  const recovered = await harness.runtime.run(automation.id);
  assert.equal(recovered.run.sessionId, "recovered-session");
  assert.equal(createAttempts, 2, "a failed operation must not poison the automation queue");
}

{
  let readyAttempts = 0;
  const harness = createHarness({
    ready: async () => {
      readyAttempts += 1;
      if (readyAttempts === 1) throw new Error("runtime not ready");
    },
  });
  const automation = await saveDefinition(harness);
  await assert.rejects(harness.runtime.run(automation.id), /runtime not ready/);
  const recovered = await harness.runtime.run(automation.id);
  assert.ok(recovered.run.id);
  assert.equal(readyAttempts, 3, "the recovered run reaches both command and start boundaries");
}

{
  const harness = createHarness();
  const automation = await saveDefinition(harness);
  await harness.repository.patchDefinition(automation.id, { nextRunAt: "2000-01-01 00:00:00" });
  assert.equal(harness.runtime.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }), true);
  const manual = harness.runtime.run(automation.id);
  await harness.runtime.flush();
  const manualResult = await Promise.allSettled([manual]);
  assert.equal(harness.sessions.length, 1, "alarm/manual race must create one session");
  assert.equal(manualResult[0].status, "rejected");
  assert.equal((await harness.repository.listRuns(automation.id, { limit: 20 })).length, 1);
}

{
  const nowMs = Date.parse("2026-07-17T03:55:30Z");
  const harness = createHarness({ clock: () => nowMs });
  const automation = await saveDefinition(harness, { missedPolicy: "skip" });
  await harness.repository.patchDefinition(automation.id, { nextRunAt: "2026-07-17 11:55:00" });
  assert.equal(harness.runtime.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }), true);
  await harness.runtime.flush();
  const runs = await harness.repository.listRuns(automation.id, { limit: 20 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "running", "an on-time tick must run even when missed runs should be skipped");
  assert.equal(runs[0].triggerType, "schedule");
  assert.equal(runs[0].delayed, false);
  assert.equal(harness.sessions.length, 1);
}

{
  const harness = createHarness();
  const automation = await saveDefinition(harness, { missedPolicy: "skip" });
  await harness.repository.patchDefinition(automation.id, { nextRunAt: "2000-01-01 00:00:00" });
  assert.equal(harness.runtime.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }), true);
  await harness.runtime.flush();
  const runs = await harness.repository.listRuns(automation.id, { limit: 20 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "skipped");
  assert.equal(runs[0].triggerType, "catchup");
  assert.equal(runs[0].delayed, true);
  assert.equal(harness.sessions.length, 0, "missed skip must not create a session");
}

{
  const harness = createHarness({
    stopSession: async ({ sessionId, runtime }) => {
      await runtime.syncSessionOutcome(sessionId);
    },
  });
  const automation = await saveDefinition(harness);
  const { run } = await harness.runtime.run(automation.id);
  const result = await withTimeout(harness.runtime.remove(automation.id));
  assert.equal(result.deleted, true);
  assert.deepEqual(harness.stopped, [], "deleting a Session already aborts its active Agent; a separate stop would re-enter the automation queue");
  assert.deepEqual(harness.removed, [run.sessionId]);
  assert.equal((await harness.repository.listDefinitions()).length, 0);
  assert.equal((await harness.repository.listRuns(automation.id, { limit: 20 })).length, 0);
  assert.equal(await harness.runtime.syncSessionOutcome(run.sessionId), false);
  assert.equal(await harness.runtime.syncSessionOutcome(run.sessionId), false);
  assert.equal(harness.runtime.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }), true);
  await harness.runtime.flush();
  assert.equal((await harness.repository.listDefinitions()).length, 0, "late terminal events and scheduler ticks must not revive a deleted automation");
  assert.equal(harness.sessions.length, 1, "a deleted automation must not schedule another Session");
}

{
  const warnings = [];
  const harness = createHarness({
    removeSession: async () => {
      throw new Error("session cleanup unavailable");
    },
    logger: {
      warn: (...args) => warnings.push(args),
      debug() {},
    },
  });
  const automation = await saveDefinition(harness);
  await harness.runtime.run(automation.id);
  const result = await harness.runtime.remove(automation.id);
  assert.equal(result.deleted, true);
  assert.equal((await harness.repository.listDefinitions()).length, 0);
  assert.equal((await harness.repository.listRuns(automation.id, { limit: 20 })).length, 0);
  assert.equal(warnings.length, 1, "Session cleanup failure should be observable without rolling back deletion");
}

console.log("automation runtime concurrency tests passed");
