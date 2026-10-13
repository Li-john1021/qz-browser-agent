import assert from "node:assert/strict";
import test from "node:test";
import { mergeBudgets } from "../benchmarks/conversation-render/tools/merge-budgets.mjs";

test("budget overrides preserve defaults and cannot alter inherited objects", () => {
  const inherited = { qzBudgetInherited: {} };
  const target = Object.assign(Object.create(inherited), { elapsedMs: { render: 500, switch: 300 } });
  const input = JSON.parse('{"__proto__":{"qzBudgetPollution":1},"constructor":{"prototype":{"qzBudgetPollution":2}},"elapsedMs":{"render":100,"__proto__":{"qzBudgetPollution":3}},"qzBudgetInherited":{"value":4}}');
  try {
    mergeBudgets(target, input);
    assert.deepEqual(target.elapsedMs, { render: 100, switch: 300 });
    assert.equal({}.qzBudgetPollution, undefined);
    assert.equal(Object.hasOwn(target, "constructor"), false);
    assert.deepEqual(inherited.qzBudgetInherited, {});
    assert.deepEqual(target.qzBudgetInherited, { value: 4 });
  } finally {
    delete Object.prototype.qzBudgetPollution;
  }
});
