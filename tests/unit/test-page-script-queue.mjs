import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import vm from "node:vm";

const source = transformSync(readFileSync(new URL("../../src/capabilities/script/tools.ts", import.meta.url), "utf8"), { loader: "ts", charset: "utf8", minifySyntax: false }).code;
const start = source.indexOf("const pageScriptQueuesByTabId =");
const end = source.indexOf("async function ensureRunScriptOffscreenDocument", start);
assert.ok(start >= 0 && end > start, "should find page script queue implementation");
const nestedStart = source.indexOf("function isNestedRunScriptContext", end);
const nestedEnd = source.indexOf("function handleRunScriptInnerRuntimeMessage", nestedStart);
assert.ok(nestedStart >= 0 && nestedEnd > nestedStart, "should find nested run_script context helper");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.details = details;
  }
}

const context = {
  ToolExecutionError,
  Promise,
  Number,
  Math,
  setTimeout,
  clearTimeout,
};
vm.createContext(context);
vm.runInContext(`
${source.slice(start, end)}
${source.slice(nestedStart, nestedEnd)}
globalThis.__queueExports = {
  runPageScriptExclusive,
  isNestedRunScriptContext,
  pageScriptQueuesByTabId,
};
`, context);

const {
  runPageScriptExclusive,
  isNestedRunScriptContext,
  pageScriptQueuesByTabId,
} = context.__queueExports;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

assert.equal(isNestedRunScriptContext({}), false);
assert.equal(isNestedRunScriptContext({ runScriptToolDepth: 0 }), false);
assert.equal(isNestedRunScriptContext({ runScriptToolDepth: "1" }), true);

await testSameTabSerializes();
await testDifferentTabsRunTogether();
await testFailureDoesNotPoisonQueue();
await testAbortWhileQueued();

assert.equal(pageScriptQueuesByTabId.size, 0, "queue should be empty after all tests");
console.log("page script queue tests passed");

async function testSameTabSerializes() {
  const firstRelease = deferred();
  const events = [];

  const first = runPageScriptExclusive(100, null, async () => {
    events.push("first:start");
    await firstRelease.promise;
    events.push("first:end");
    return "first";
  });
  const second = runPageScriptExclusive(100, null, async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  await delay(10);
  assert.deepEqual(events, ["first:start"], "same-tab second script should wait for first");
  firstRelease.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(pageScriptQueuesByTabId.size, 0, "same-tab queue should clean up");
}

async function testDifferentTabsRunTogether() {
  const release = deferred();
  const events = [];

  const first = runPageScriptExclusive(201, null, async () => {
    events.push("tab201:start");
    await release.promise;
    events.push("tab201:end");
  });
  const second = runPageScriptExclusive(202, null, async () => {
    events.push("tab202:start");
  });

  await delay(10);
  assert.deepEqual(events, ["tab201:start", "tab202:start"], "different tabs should not share the queue");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(pageScriptQueuesByTabId.size, 0, "different-tab queues should clean up");
}

async function testFailureDoesNotPoisonQueue() {
  const events = [];
  const first = runPageScriptExclusive(300, null, async () => {
    events.push("first:start");
    throw new Error("boom");
  });
  const second = runPageScriptExclusive(300, null, async () => {
    events.push("second:start");
    return "ok";
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  assert.deepEqual(events, ["first:start", "second:start"], "queue should advance after a failed script");
  assert.equal(pageScriptQueuesByTabId.size, 0, "failed queue should clean up");
}

async function testAbortWhileQueued() {
  const release = deferred();
  const events = [];
  const controller = new AbortController();

  const first = runPageScriptExclusive(400, null, async () => {
    events.push("first:start");
    await release.promise;
  });
  const second = runPageScriptExclusive(400, controller.signal, async () => {
    events.push("second:start");
  });

  await delay(10);
  controller.abort();
  await assert.rejects(second, err => (
    err?.code === "OPERATION_ABORTED" && err?.details?.phase === "queue"
  ));
  assert.deepEqual(events, ["first:start"], "aborted queued script should not run");
  release.resolve();
  await first;
  await delay(0);
  assert.equal(pageScriptQueuesByTabId.size, 0, "aborted queue should clean up after active script releases");
}
