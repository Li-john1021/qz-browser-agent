import assert from "node:assert/strict";
import test from "node:test";
import { genSessionId, normalizeSessionId } from "../../src/shared/session/session-store.js";
import { genAutomationId, genAutomationRunId, normalizeAutomation, normalizeAutomationRun } from "../../src/shared/automation-store.js";

test("session and automation identities remain distinct within the same clock tick", (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_000);
  t.mock.method(Math, "random", () => 0);
  const ids = Array.from({ length: 1000 }, () => [genSessionId(), genAutomationId(), genAutomationRunId()]).flat();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(normalizeSessionId(id), id);
});

test("stored legacy and new identities retain their values", () => {
  for (const id of ["legacy_session", genSessionId()]) assert.equal(normalizeSessionId(id), id);
  for (const id of ["auto_legacy", genAutomationId()]) assert.equal(normalizeAutomation({ id }).id, id);
  for (const id of ["run_legacy", genAutomationRunId()]) {
    assert.equal(normalizeAutomationRun({ id, automationId: "auto_legacy" }).id, id);
  }
});

test("generated identities preserve the notification routing character set", () => {
  assert.match(genSessionId(), /^[a-z0-9]+$/);
  assert.match(genAutomationId(), /^auto_[a-z0-9]+$/);
  assert.match(genAutomationRunId(), /^run_[a-z0-9]+$/);
});
