import assert from "node:assert/strict";
import test from "node:test";
import { createScrollFuzz } from "../benchmarks/conversation-render/tools/scroll-fuzz.mjs";

test("scroll fuzz seeds reproduce directions, distances and pauses", () => {
  const series = seed => { const next = createScrollFuzz(seed); return Array.from({ length: 40 }, next); };
  const first = series(12345);
  assert.deepEqual(first, series(12345));
  assert.notDeepEqual(first, series(12346));
  for (const plan of first) {
    assert.ok(plan.deltas[0] < 0);
    assert.ok(plan.deltas.some(delta => delta > 0));
    assert.ok(plan.deltas.every(delta => Math.abs(delta) >= 0.12 && Math.abs(delta) <= 0.77));
    assert.ok(plan.holdMs >= 80 && plan.holdMs <= 320);
    assert.ok(plan.gapMs >= 16 && plan.gapMs <= 80);
  }
});

test("invalid seeds cannot silently produce non-random plans", () => {
  for (const seed of [0, -1, 1.1, NaN, Infinity, 2 ** 32]) assert.throws(() => createScrollFuzz(seed));
});
