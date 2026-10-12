import assert from "node:assert/strict";
import {
  buildNextSessionGoal,
  buildNextSessionTracker,
  normalizeGoalAction,
  normalizeSessionGoal,
  normalizeSessionTracker,
  normalizeTrackerAction,
  summarizeSessionGoal,
  summarizeSessionTracker,
} from "../../src/background/session/task-state.js";

assert.equal(normalizeGoalAction("unknown"), "update");
assert.equal(normalizeTrackerAction("unknown"), "update");

const createdGoal = buildNextSessionGoal("create", {
  objective: "Collect three pages",
  criteria: "Persist and verify all rows",
  runId: "run-1",
});
assert.equal(createdGoal.status, "active");
assert.equal(createdGoal.version, 1);

const blockedGoal = buildNextSessionGoal("block", {
  progress: "Two pages persisted",
  next: "Wait for login",
}, createdGoal);
assert.equal(blockedGoal.status, "blocked");
assert.equal(blockedGoal.version, 2);
assert.equal(buildNextSessionGoal("clear", {}, blockedGoal), null);
assert.throws(
  () => buildNextSessionGoal("complete", {}, null),
  error => error?.code === "MISSING_GOAL",
);
assert.equal(normalizeSessionGoal({ status: "active" }), null);
assert.equal(normalizeSessionGoal({ status: "complete" })?.status, "complete");
assert.deepEqual(summarizeSessionGoal(blockedGoal), {
  status: "blocked",
  objective: "Collect three pages",
  progress: "Two pages persisted",
  next: "Wait for login",
  checkpoint: "",
  version: 2,
});

const tracker = buildNextSessionTracker("start", {
  mode: "steps",
  title: "Research",
  steps: ["Collect", "Verify", "Publish"],
  total: 3,
});
assert.equal(tracker.currentStep, 1);
assert.deepEqual(tracker.steps.map(step => step.status), ["active", "pending", "pending"]);

const progressed = buildNextSessionTracker("update", {
  completed: 2,
  current: 9,
  currentStep: 3,
  stats: { rows: 40, nested: { page: 2 } },
}, tracker);
assert.equal(progressed.current, 3, "tracker counts should clamp to the configured total");
assert.equal(progressed.completed, 2);
assert.deepEqual(progressed.steps.map(step => step.status), ["done", "done", "active"]);
assert.deepEqual(summarizeSessionTracker(progressed), {
  mode: "steps",
  title: "Research",
  current: 3,
  completed: 2,
  total: 3,
  note: "",
});
assert.equal(buildNextSessionTracker("finish", {}, progressed), null);
assert.equal(normalizeSessionTracker(null), null);

console.log("session task state tests passed");
