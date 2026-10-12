import assert from "node:assert/strict";
import {
  SESSION_RUNTIME_STATUS,
  isActiveSessionRuntimeStatus,
  isSettledSessionRuntimeStatus,
  isTerminalSessionRuntimeStatus,
  normalizeSessionRuntimeStatus,
} from "../../src/shared/session/session-runtime-status.js";

assert.equal(normalizeSessionRuntimeStatus(" RUNNING "), SESSION_RUNTIME_STATUS.RUNNING);
assert.equal(normalizeSessionRuntimeStatus("canceled"), SESSION_RUNTIME_STATUS.CANCELLED);
assert.equal(normalizeSessionRuntimeStatus("unknown"), "");
assert.equal(
  normalizeSessionRuntimeStatus("unknown", SESSION_RUNTIME_STATUS.IDLE),
  SESSION_RUNTIME_STATUS.IDLE,
);

for (const status of [
  SESSION_RUNTIME_STATUS.PENDING,
  SESSION_RUNTIME_STATUS.RUNNING,
  SESSION_RUNTIME_STATUS.WAITING_USER,
]) {
  assert.equal(isActiveSessionRuntimeStatus(status), true, `${status} should be active`);
  assert.equal(isTerminalSessionRuntimeStatus(status), false, `${status} should not be terminal`);
  assert.equal(isSettledSessionRuntimeStatus(status), false, `${status} should not be settled`);
}

for (const status of [
  SESSION_RUNTIME_STATUS.COMPLETED,
  SESSION_RUNTIME_STATUS.ABORTED,
  SESSION_RUNTIME_STATUS.CANCELLED,
  SESSION_RUNTIME_STATUS.ERROR,
  SESSION_RUNTIME_STATUS.INTERRUPTED,
]) {
  assert.equal(isActiveSessionRuntimeStatus(status), false, `${status} should not be active`);
  assert.equal(isTerminalSessionRuntimeStatus(status), true, `${status} should be terminal`);
  assert.equal(isSettledSessionRuntimeStatus(status), true, `${status} should be settled`);
}

assert.equal(isTerminalSessionRuntimeStatus(SESSION_RUNTIME_STATUS.IDLE), false, "idle is quiescent, not a run terminal event");
assert.equal(isSettledSessionRuntimeStatus(SESSION_RUNTIME_STATUS.IDLE), true, "idle is settled for persistence and UI state");

console.log("session runtime status contract tests passed");
