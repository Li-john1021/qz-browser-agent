import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionCommands } from "../../src/background/session/commands.js";

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { resolve, promise }; };
function fixture() {
  const subscribers = new Map();
  let policy = async () => ({}), deleted = false;
  const supervisor = createSessionSupervisor({ createAgent: lease => ({
    subscribe(fn) { subscribers.set(lease.sessionId, fn); return () => subscribers.delete(lease.sessionId); },
    abort() {}, exportSession: () => [], getState: () => ({}),
  }) });
  const runtime = {
    normalizeCurrentTool: value => value || null,
    normalizePendingFollowUps: value => value || [],
    set(id, patch) { return supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }); },
  };
  const commands = createSessionCommands({
    runtime,
    agents: {},
    transcript: {},
    artifacts: {},
    tabs: {},
    sessionRuntimeReady: Promise.resolve(), sessionSupervisor: supervisor,
    sessionRepository: { isWriteBlocked: () => deleted },
    normalizeSessionId: value => String(value || "").trim(), getSessions: () => policy(),
    isAutomationSessionTree: () => false, broadcast() {}, normalizeRuntimeStatus: value => value || "idle",
  });
  async function start(id, runId) { const entry = supervisor.getEntry(id); await entry.ready; subscribers.get(id)({ type: "agent_start", runId }); }
  return { supervisor, commands, runtime, start, setPolicy: value => { policy = value; }, markDeleted: () => { deleted = true; } };
}
const create = (sessionId, runId, extra = {}) => ({ sessionId, runId, action: "create", objective: "Collect items", criteria: "Saved", ...extra });

test("late Goal writes cannot cross stop, replacement run or delete authority", async () => {
  const f = fixture(); await f.start("s", "old");
  await f.commands.updateSessionGoal(create("s", "old"));
  await f.supervisor.revoke("s");
  await assert.rejects(f.commands.updateSessionGoal(create("s", "old")), { code: "STALE_RUN" });
  await f.start("s", "new");
  await assert.rejects(f.commands.updateSessionGoal(create("s", "old")), { code: "STALE_RUN" });
  await f.commands.updateSessionGoal(create("s", "new"));
  f.markDeleted(); await f.supervisor.remove("s");
  await assert.rejects(f.commands.updateSessionGoal(create("s", "new")), { code: "SESSION_DELETED" });
  assert.equal(f.supervisor.peekEntry("s"), null, "rejected writes never recreate a deleted handle");
});

test("Goal writes serialize with revoke while different Sessions remain concurrent", async () => {
  const f = fixture(); await f.start("a", "run-a"); await f.start("b", "run-b");
  const gate = deferred(), entered = deferred(); let reads = 0;
  f.setPolicy(async () => { if (++reads === 1) { entered.resolve(); await gate.promise; } return {}; });
  const first = f.commands.updateSessionGoal(create("a", "run-a")); await entered.promise;
  let stopped = false;
  const stop = f.supervisor.revoke("a", { beforeRelease: () => { stopped = true; } });
  const late = f.commands.updateSessionGoal(create("a", "run-a"));
  await f.commands.updateSessionGoal(create("b", "run-b"));
  assert.equal(stopped, false, "stop and write share the same Session queue");
  gate.resolve(); await first; await stop;
  await assert.rejects(late, { code: "STALE_RUN" });
  assert.equal(stopped, true);
});

test("cancellation during policy lookup prevents commit; UI clear needs no live Agent", async () => {
  const f = fixture(); await f.start("s", "run");
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  f.setPolicy(async () => { entered.resolve(); await gate.promise; return {}; });
  const pending = f.commands.updateSessionGoal(create("s", "run", { signal: controller.signal }));
  await entered.promise; controller.abort(); gate.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.supervisor.getRuntime("s"), null);
  f.setPolicy(async () => ({})); await f.commands.updateSessionGoal({ sessionId: "idle", action: "clear" });
  assert.equal(f.supervisor.peekEntry("idle").agent, null);
});

test("commands capture supplied owner methods at construction", async () => {
  const f = fixture();
  f.runtime.set = () => { throw new Error("late owner mutation must not replace the command port"); };
  await f.start("s", "run");
  await f.commands.updateSessionGoal(create("s", "run"));
  assert.equal(f.supervisor.getRuntime("s").goal.objective, "Collect items");
});
