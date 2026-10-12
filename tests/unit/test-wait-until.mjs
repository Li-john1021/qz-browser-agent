import assert from "node:assert/strict";

const storageData = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]));
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

const tools = await import("../../src/background/tools/runtime.js");

const schemas = new Map(tools.getToolSchemas().map(item => [item.function.name, item.function]));
const relativeSchema = schemas.get("wait");
const absoluteSchema = schemas.get("wait_until");

assert.ok(relativeSchema, "relative wait should remain registered");
assert.deepEqual(relativeSchema.parameters.required, ["seconds"]);
assert.ok(relativeSchema.parameters.properties.seconds);
assert.equal(relativeSchema.parameters.properties.until, undefined);
assert.ok(absoluteSchema, "absolute wait should be registered");
assert.deepEqual(absoluteSchema.parameters.required, ["until"]);
assert.deepEqual(Object.keys(absoluteSchema.parameters.properties), ["until"]);
assert.equal(absoluteSchema.parameters.anyOf, undefined, "absolute wait should have a simple provider-safe schema");
assert.deepEqual(tools.getToolIdentity("wait_until"), {
  name: "wait_until",
  capabilityId: "wait_until",
  title: "等待到指定时间",
  familyId: "confirm",
  familyTitle: "等待确认",
});

const relativeResult = await tools.executeTool("wait", { seconds: 0 });
assert.deepEqual(relativeResult, { waitedSeconds: 0 }, "relative wait behavior should stay compatible");

await assert.rejects(
  tools.executeTool("wait_until", {}),
  error => error?.code === "MISSING_REQUIRED_ARGUMENTS" && error?.details?.missing?.includes("until"),
  "until should be required by the normal tool argument validator",
);

for (const until of [
  "2026-02-30T12:00:00+08:00",
  "2026-07-17T12:00:00",
  "2026-07-17T24:00:00+08:00",
  "2026-07-17T12:00:00+14:01",
  "2026-07-17T12:00:00+08:60",
  "2026-02-30 12:00:00",
]) {
  await assert.rejects(
    tools.executeTool("wait_until", { until }),
    error => error?.code === "INVALID_WAIT_UNTIL",
    `invalid absolute time should be rejected: ${until}`,
  );
}

const pastBeijing = await tools.executeTool("wait_until", { until: "2000-01-01 08:00:00" });
assert.equal(pastBeijing.pastDue, true, "past targets should return immediately");
assert.equal(pastBeijing.targetAt, "2000-01-01 08:00:00", "timezone-less compatibility format should mean Beijing time");
assert.equal(pastBeijing.mode, "absolute");
assert.ok(pastBeijing.lateBySeconds > 0);

const pastZonedIso = await tools.executeTool("wait_until", { until: "2000-01-01T00:00:00+08:00" });
assert.equal(pastZonedIso.pastDue, true, "zoned ISO input should be accepted");
assert.equal(pastZonedIso.targetAt, "2000-01-01 00:00:00");

const tooFar = new Date(Date.now() + (2 * 60 * 60 * 1000) + 5000).toISOString();
await assert.rejects(
  tools.executeTool("wait_until", { until: tooFar }),
  error => error?.code === "WAIT_UNTIL_TOO_FAR"
    && error?.details?.maxWaitSeconds === 7200
    && error?.details?.remainingSeconds > 7200,
  "long waits should stay with the automation scheduler",
);

const futureTargetMs = Date.now() + 80;
const futureResult = await tools.executeTool("wait_until", { until: new Date(futureTargetMs).toISOString() });
assert.equal(futureResult.pastDue, false);
assert.ok(Date.now() >= futureTargetMs, "wait_until must not resolve before its wall-clock target");
assert.ok(futureResult.waitedSeconds >= 0.05, "wait_until should report the actual elapsed wait");

const abortController = new AbortController();
const abortedWait = tools.executeTool("wait_until", {
  until: new Date(Date.now() + 5000).toISOString(),
}, abortController.signal);
setTimeout(() => abortController.abort(), 10);
await assert.rejects(
  abortedWait,
  error => error?.code === "OPERATION_ABORTED",
  "an active absolute wait should honor AbortSignal",
);

const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(
  tools.executeTool("wait_until", {
    until: new Date(Date.now() + 5000).toISOString(),
  }, alreadyAborted.signal),
  error => error?.code === "OPERATION_ABORTED",
  "an already-aborted run must not start waiting",
);

await assertWallClockIsRechecked();

console.log("wait until tool tests passed");

async function assertWallClockIsRechecked() {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = Date.parse("2026-07-17T03:59:00.000Z");
  let nextTimerId = 0;
  const activeTimers = new Set();
  const observedDelays = [];

  Date.now = () => nowMs;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const timerId = ++nextTimerId;
    const delayMs = Math.max(0, Number(delay) || 0);
    activeTimers.add(timerId);
    observedDelays.push(delayMs);
    queueMicrotask(() => {
      if (!activeTimers.has(timerId)) return;
      nowMs += delayMs + (observedDelays.length === 1 ? 15_000 : 0);
      callback(...args);
    });
    return timerId;
  };
  globalThis.clearTimeout = timerId => activeTimers.delete(timerId);

  try {
    const targetMs = nowMs + 45_000;
    const result = await tools.executeTool("wait_until", { until: new Date(targetMs).toISOString() });
    assert.deepEqual(observedDelays, [30_000], "absolute waits should recheck wall time in bounded slices without a generic outer timer");
    assert.equal(result.pastDue, false);
    assert.equal(result.waitedSeconds, 45);
    assert.equal(result.lateBySeconds, 0);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}
