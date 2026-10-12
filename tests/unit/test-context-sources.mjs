import assert from "node:assert/strict";
import test from "node:test";
import { createContextSources, ContextSourceError } from "../../src/background/context-sources.js";

const request = { sessionId: "session-a", runId: "run-a", epoch: 2, reason: "snapshot" };
const deferred = () => {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};

test("sources run concurrently but commit in registration order and share a bounded text budget", async () => {
  const first = deferred();
  const started = [];
  const collect = createContextSources([
    { id: "first", title: "First", read: async input => { started.push(input); await first.promise; return "abcde"; } },
    { id: "second", title: "Second", read: () => { started.push("second"); first.resolve(); return "fghij"; } },
  ], { maxTextChars: 8 });
  const result = await collect(request);
  assert.equal(started.length, 2);
  assert.equal(started[0].sessionId, request.sessionId);
  assert.equal(started[0].runId, request.runId);
  assert.equal(started[0].epoch, request.epoch);
  assert.ok(Object.isFrozen(started[0]));
  assert.deepEqual(result.sources.map(item => [item.id, item.text]), [["first", "abcde"], ["second", "fgh"]]);
  assert.deepEqual(result.contextDiagnostics, [{ sourceId: "second", code: "CONTEXT_SOURCE_TRUNCATED" }]);
  assert.throws(() => { result.sources[0].text = "changed"; }, TypeError);
});

test("optional failure and oversize data produce safe diagnostics; required failure blocks collection", async () => {
  const collect = createContextSources([
    { id: "failed", read: () => { throw new Error("secret-token-must-not-escape"); } },
    { id: "large", maxChars: 5, read: () => ({ large: "payload" }) },
    { id: "invalid", title: "Text", read: () => ({ text: "wrong shape" }) },
    { id: "ready", read: () => ({ answer: 42 }) },
  ]);
  const result = await collect(request);
  assert.deepEqual(result.values.get("ready"), { answer: 42 });
  assert.equal(result.contextDiagnostics.length, 3);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  for (const read of [() => { throw new Error("secret"); }, () => null]) {
    await assert.rejects(createContextSources([{ id: "required", required: true, read }])(request), error => {
      assert.ok(error instanceof ContextSourceError);
      assert.equal(error.code, "CONTEXT_SOURCE_REQUIRED");
      assert.equal(error.sourceId, "required");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("deadlines abort each source, allow other sources to finish and ignore a late result", async () => {
  const late = deferred();
  let signal;
  const collect = createContextSources([
    { id: "slow", timeoutMs: 15, read: input => { signal = input.signal; return late.promise; } },
    { id: "ready", read: () => 42 },
  ]);
  const result = await collect(request);
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.contextDiagnostics, [{ sourceId: "slow", code: "CONTEXT_SOURCE_TIMEOUT" }]);
  late.resolve("late data");
  await Promise.resolve();
  assert.deepEqual([...result.values], [["ready", 42]]);
});

test("parent cancellation propagates without being converted to optional failure", async () => {
  const controller = new AbortController();
  const started = deferred();
  let signal;
  const collect = createContextSources([{ id: "cancel", read: input => {
    signal = input.signal;
    started.resolve();
    return new Promise(() => {});
  } }]);
  const result = collect({ ...request, signal: controller.signal });
  await started.promise;
  controller.abort("a custom stop reason must still be cancellation");
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(signal.aborted, true);
  let called = false;
  await assert.rejects(createContextSources([{ id: "never", read: () => { called = true; } }])({ ...request, signal: controller.signal }), { name: "AbortError" });
  assert.equal(called, false);
});

test("reason selection avoids unrelated reads and results do not share source-owned mutable objects", async () => {
  const value = { tabs: [{ id: 10 }] };
  const collect = createContextSources([
    { id: "snapshot", read: () => { throw new Error("should not run"); } },
    { id: "tab", reasons: ["tool"], read: () => value },
  ]);
  const result = await collect({ ...request, reason: "tool" });
  value.tabs[0].id = 20;
  assert.deepEqual(result.values.get("tab"), { tabs: [{ id: 10 }] });
  assert.deepEqual(result.contextDiagnostics, []);
});

test("registration rejects duplicates and invalid limits instead of silently replacing a source", () => {
  const source = { id: "one", read: () => null };
  assert.throws(() => createContextSources([source, source]), /duplicate/);
  assert.throws(() => createContextSources([{ ...source, timeoutMs: 0 }]), /deadline/);
  assert.throws(() => createContextSources([{ ...source, maxChars: -1 }]), /budget/);
});

test("the documented task note example composes without modifying Agent messages", async () => {
  const { taskNoteSource } = await import("../fixtures/capabilities/example/context-and-observer.js");
  const result = await createContextSources([taskNoteSource(async id => `Note for ${id}`)])(request);
  assert.deepEqual(result.sources, [{ id: "example.task-note", title: "任务笔记", text: "Note for session-a" }]);
});
