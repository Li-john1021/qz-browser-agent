import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderRateLearningRuntime,
  PROVIDER_RATE_LEARNING_STORAGE_KEY,
} from "../../src/background/llm/provider-rate-runtime.js";
import { createProviderRateGovernor } from "../../src/background/llm/provider-rate-governor.js";

const POLICY = Object.freeze({
  windowMs: 60_000,
  requestsPerWindow: 19,
  tokensPerWindow: 980_000,
  burstToleranceMs: 6_000,
  waitNoticeThresholdMs: 5_000,
});

test("provider rate learning persists across gateway lifetimes and restores trace identity", async () => {
  const storage = memoryStorage();
  const traces = [];
  const first = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => 1_000 });
  const learned = await first.recordSuccess({
    key: "deepseek|openai|https://example.test/v1",
    usage: { requests: 18, tokens: 900_000 },
    windowMs: 60_000,
    sessionId: "session-a",
    runId: "run-a",
    spanId: "run-a:llm:1",
  });
  assert.deepEqual(
    [learned.policy.requestsPerWindow, learned.policy.tokensPerWindow],
    [23, 1_125_000],
  );
  await first.flush();

  const second = createProviderRateLearningRuntime({
    storage,
    policy: POLICY,
    now: () => 2_000,
    onTrace: event => traces.push(event),
  });
  const restored = await second.getPolicy({
    key: "deepseek|openai|https://example.test/v1",
    sessionId: "session-b",
    runId: "run-b",
    spanId: "run-b:llm:2",
  });
  assert.deepEqual(
    [restored.requestsPerWindow, restored.tokensPerWindow],
    [23, 1_125_000],
  );
  assert.deepEqual(
    [traces[0].phase, traces[0].sessionId, traces[0].runId, traces[0].spanId],
    ["restored", "session-b", "run-b", "run-b:llm:2"],
  );
});

test("ordinary traffic below the probe boundary causes no storage write or learning trace", async () => {
  const storage = memoryStorage();
  const traces = [];
  const runtime = createProviderRateLearningRuntime({
    storage,
    policy: POLICY,
    now: () => 1_000,
    onTrace: event => traces.push(event),
  });
  const result = await runtime.recordSuccess({
    key: "quiet|openai|https://quiet.test/v1",
    usage: { requests: 3, tokens: 100_000 },
    windowMs: 60_000,
  });
  assert.equal(result.changed, false);
  assert.equal(storage.setCalls, 0);
  assert.equal(traces.length, 0);
});

test("failed estimates remain admission debt but never prove successful capacity", async () => {
  const governor = createProviderRateGovernor(POLICY);
  const runtime = createProviderRateLearningRuntime({ governor, policy: POLICY, now: () => 1_000 });
  const key = "mixed|openai|https://mixed.test/v1";
  const failed = await runtime.beginRequest({
    key,
    estimatedTokens: 900_000,
    enforce: false,
  });
  await runtime.failRequest({
    admission: failed,
    failure: { kind: "network", code: "NETWORK_ERROR" },
  });

  const completed = await runtime.beginRequest({
    key,
    estimatedTokens: 100_000,
    enforce: false,
  });
  assert.equal(runtime.settleRequest({ admission: completed }), true);
  await afterMicrotasks(10);

  assert.deepEqual(
    [governor.getUsage(key).requests, governor.getUsage(key).tokens],
    [2, 1_000_000],
    "the failed attempt must continue to protect the provider from immediate over-admission",
  );
  assert.deepEqual(
    [governor.getUsage(key, { settledOnly: true }).requests, governor.getUsage(key, { settledOnly: true }).tokens],
    [1, 100_000],
  );
  assert.equal(
    (await runtime.getPolicy({ key })).tokensPerWindow,
    POLICY.tokensPerWindow,
    "a large failed estimate plus a small success must not raise the learned TPM",
  );
});

test("structured provider signals update policy while ambiguous 429 and quota preserve capacity", async () => {
  const traces = [];
  const runtime = createProviderRateLearningRuntime({
    policy: POLICY,
    now: () => 10_000,
    onTrace: event => traces.push(event),
  });
  const key = "bailian|openai|https://dashscope.test/v1";

  const advertised = await runtime.recordProviderSignal({
    key,
    status: 200,
    headers: { "x-ratelimit-limit-requests": "30", "x-ratelimit-limit-tokens": "2000000" },
    sessionId: "session-rate",
    runId: "run-rate",
    spanId: "run-rate:llm:1",
  });
  assert.deepEqual(
    [advertised.policy.requestsPerWindow, advertised.policy.tokensPerWindow],
    [30, 980_000],
  );

  const reset = await runtime.recordProviderSignal({
    key,
    status: 429,
    headers: { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "3s" },
  });
  assert.equal(reset.providerRetryAfterMs, 3_000);

  const ambiguous = await runtime.recordProviderSignal({
    key,
    status: 429,
    usage: { requests: 4, tokens: 100_000 },
    windowMs: 60_000,
  });
  assert.equal(ambiguous.signal.trusted, false);
  assert.equal(ambiguous.retryAfterMs, 2_000);
  assert.equal(ambiguous.providerRetryAfterMs, null, "the local fallback must not become a shared provider cooldown");
  assert.equal(ambiguous.policy.tokensPerWindow, 980_000);
  assert.equal(traces.at(-1).pressurePct, 100);
  assert.equal(traces.at(-1).pressureStreak, 1);

  const quota = await runtime.recordProviderSignal({
    key,
    status: 429,
    code: "Throttling.AllocationQuota",
    kind: "quota",
    usage: { requests: 5, tokens: 120_000 },
    windowMs: 60_000,
  });
  assert.equal(quota.signal.type, "quota");
  assert.equal(quota.retryAfterMs, 0);
  assert.equal(quota.policy.tokensPerWindow, 980_000);
  assert.equal(traces.at(-2).trusted, false);
  assert.equal(traces.at(-1).signal, "quota");
});

test("caller advice cannot shorten a learned provider cooldown", async () => {
  const governor = createProviderRateGovernor(POLICY);
  const runtime = createProviderRateLearningRuntime({ governor, policy: POLICY, now: () => 1_000 });
  const admission = await runtime.beginRequest({
    key: "shared|openai|https://shared.test/v1",
    estimatedTokens: 1_000,
    enforce: false,
    options: {
      onProviderResponse: () => ({ retryAfterMs: 1_000, providerRetryAfterMs: 1_000 }),
    },
  });
  const advice = await admission.options.onProviderResponse({
    status: 429,
    ok: false,
    kind: "transient",
    headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "3s" },
  });
  assert.deepEqual(
    [advice.retryAfterMs, advice.providerRetryAfterMs],
    [3_000, 3_000],
  );
});

test("opaque congestion pressure persists, merges concurrent failures, and expires independently", async () => {
  let currentTime = 1000;
  const storage = memoryStorage({ writeDelayMs: 1 });
  const traces = [];
  const key = "opaque|openai|https://opaque.test/v1";
  const runtime = createProviderRateLearningRuntime({
    storage,
    policy: POLICY,
    now: () => currentTime,
    onTrace: event => traces.push(event),
  });
  await runtime.recordProviderSignal({
    key,
    status: 200,
    headers: { "x-ratelimit-limit-requests": "40", "x-ratelimit-limit-tokens": "2000000" },
  });
  currentTime = 2000;
  await Promise.all([
    runtime.recordProviderSignal({ key, status: 429, usage: { requests: 10, tokens: 400_000 }, windowMs: 60_000 }),
    runtime.recordProviderSignal({ key, status: 429, usage: { requests: 11, tokens: 500_000 }, windowMs: 60_000 }),
  ]);
  await runtime.flush();

  const stored = storage.data[PROVIDER_RATE_LEARNING_STORAGE_KEY].providers[key];
  assert.equal(stored.pressure.scale, 80);
  assert.equal(stored.pressure.upper, 100);
  assert.equal(stored.pressure.streak, 2);
  const restored = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => currentTime });
  assert.deepEqual(await restored.getPolicy({ key }), {
    ...POLICY,
    requestsPerWindow: 32,
    tokensPerWindow: 980_000,
  });
  assert.deepEqual(
    traces.filter(event => event.signal === "rate_limit").map(event => [event.pressurePct, event.pressureStreak]),
    [[100, 1], [80, 2]],
  );

  currentTime += 30 * 60_000 + 1;
  assert.deepEqual(await runtime.getPolicy({ key, sessionId: "after-idle" }), {
    ...POLICY,
    requestsPerWindow: 40,
    tokensPerWindow: 980_000,
  });
  assert.equal(traces.at(-1).phase, "pressure_expired");
  assert.equal(traces.at(-1).sessionId, "after-idle");
});

test("learning trace exposes each opaque pressure lower and upper bound transition", async () => {
  let currentTime = 0;
  const traces = [];
  const key = "trace-bounds|openai|https://trace.test/v1";
  const runtime = createProviderRateLearningRuntime({
    policy: POLICY,
    now: () => currentTime,
    onTrace: event => traces.push(event),
  });
  await runtime.recordProviderSignal({
    key,
    status: 200,
    headers: { "x-ratelimit-limit-requests": "40", "x-ratelimit-limit-tokens": "2000000" },
  });
  currentTime = 100;
  await runtime.recordProviderSignal({ key, status: 429, usage: { requests: 10, tokens: 500_000 }, windowMs: 60_000 });
  currentTime = 2100;
  await runtime.recordProviderSignal({ key, status: 429, usage: { requests: 11, tokens: 600_000 }, windowMs: 60_000 });
  currentTime = 3000;
  await runtime.recordSuccess({ key, usage: { requests: 29, tokens: 800_000 }, windowMs: 60_000 });
  currentTime = 4000;
  await runtime.recordProviderSignal({ key, status: 429, usage: { requests: 36, tokens: 1_790_000 }, windowMs: 60_000 });

  assert.deepEqual(
    traces.map(event => [
      event.signal,
      event.pressurePct,
      event.pressureLowerPct,
      event.pressureUpperPct,
      event.pressureStreak,
    ]),
    [
      ["limits", 100, 0, 0, 0],
      ["rate_limit", 100, 0, 0, 1],
      ["rate_limit", 80, 0, 100, 2],
      ["none", 89, 80, 100, 0],
      ["rate_limit", 84, 80, 89, 1],
    ],
  );
  assert.deepEqual(
    traces.at(-1) && [traces.at(-1).rpmLower, traces.at(-1).rpmUpper, traces.at(-1).tpmLower, traces.at(-1).tpmUpper],
    [0, 0, 0, 0],
    "opaque pressure must not masquerade as a dimension-specific bound",
  );
});

test("concurrent providers serialize whole-record persistence without losing evidence", async () => {
  const storage = memoryStorage({ writeDelayMs: 1 });
  const runtime = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => 5_000 });
  await Promise.all([
    runtime.recordSuccess({
      key: "one|openai|https://one.test/v1",
      usage: { requests: 18, tokens: 900_000 },
      windowMs: 60_000,
    }),
    runtime.recordSuccess({
      key: "two|openai|https://two.test/v1",
      usage: { requests: 18, tokens: 910_000 },
      windowMs: 60_000,
    }),
  ]);
  await runtime.flush();

  const stored = storage.data[PROVIDER_RATE_LEARNING_STORAGE_KEY];
  assert.deepEqual(Object.keys(stored.providers).sort(), [
    "one|openai|https://one.test/v1",
    "two|openai|https://two.test/v1",
  ]);
});

test("concurrent evidence for one provider merges dimensions before persistence", async () => {
  const storage = memoryStorage({ writeDelayMs: 1 });
  const runtime = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => 5_000 });
  const key = "shared|openai|https://shared.test/v1";
  await Promise.all([
    runtime.recordSuccess({
      key,
      usage: { requests: 18, tokens: 100_000 },
      windowMs: 60_000,
    }),
    runtime.recordProviderSignal({
      key,
      status: 429,
      code: "TPM_RATE_LIMIT",
      usage: { requests: 18, tokens: 1_100_000 },
      windowMs: 60_000,
    }),
  ]);
  await runtime.flush();

  const state = storage.data[PROVIDER_RATE_LEARNING_STORAGE_KEY].providers[key];
  assert.equal(state.requests.lower, 18);
  assert.equal(state.tokens.upper, 1_100_000);
});

test("passive observation does not wait for persisted learning to load", async () => {
  const pendingLoad = deferred();
  const governor = createProviderRateGovernor(POLICY);
  const runtime = createProviderRateLearningRuntime({
    governor,
    storage: {
      get: () => pendingLoad.promise,
      async set() {},
    },
  });
  const admission = runtime.beginRequest({
    key: "passive|openai|https://passive.test/v1",
    estimatedTokens: 100,
    enforce: false,
  });

  try {
    const result = await Promise.race([
      admission,
      afterMicrotasks(10),
    ]);
    assert.ok(result?.current?.id, "disabled limiting must not block on chrome.storage");
  } finally {
    pendingLoad.resolve({});
  }
});

test("a stalled storage load falls back without stranding enforced admission", async () => {
  const traces = [];
  const runtime = createProviderRateLearningRuntime({
    policy: POLICY,
    storageLoadTimeoutMs: 5,
    storage: {
      get: () => new Promise(() => {}),
      async set() {},
    },
    onTrace: event => traces.push(event),
  });

  const policy = await runtime.getPolicy({ key: "stalled|openai|https://stalled.test/v1" });

  assert.equal(policy.requestsPerWindow, POLICY.requestsPerWindow);
  assert.equal(policy.tokensPerWindow, POLICY.tokensPerWindow);
  assert.deepEqual(
    traces.filter(event => event.phase === "storage_error").map(event => event.action),
    ["load"],
  );
});

test("a timed-out hydrate cannot erase previously learned providers", async () => {
  const storedKey = "stored|openai|https://stored.test/v1";
  const newKey = "new|openai|https://new.test/v1";
  const stored = {
    version: 1,
    providers: {
      [storedKey]: {
        version: 1,
        requests: { lower: 25, upper: 0, exact: 0, anchor: 25, expiresAt: 100_000 },
      },
    },
  };
  let reads = 0;
  const storage = {
    data: structuredClone(stored),
    get() {
      reads += 1;
      return reads === 1
        ? new Promise(() => {})
        : Promise.resolve({ [PROVIDER_RATE_LEARNING_STORAGE_KEY]: structuredClone(storage.data) });
    },
    async set(values) {
      storage.data = structuredClone(values[PROVIDER_RATE_LEARNING_STORAGE_KEY]);
    },
  };
  const runtime = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => 1000, storageLoadTimeoutMs: 5 });

  await runtime.getPolicy({ key: newKey });
  await runtime.recordSuccess({ key: newKey, usage: { requests: 18, tokens: 900_000 }, windowMs: 60_000 });
  await runtime.flush();

  assert.deepEqual(Object.keys(storage.data.providers).sort(), [newKey, storedKey].sort());
});

test("expired persisted evidence keeps a warm-start anchor and emits one identity-rich trace", async () => {
  const storage = memoryStorage();
  const traces = [];
  storage.data[PROVIDER_RATE_LEARNING_STORAGE_KEY] = {
    version: 1,
    providers: {
      "expired|openai|https://expired.test/v1": {
        version: 1,
        requests: { lower: 25, upper: 0, exact: 0, expiresAt: 1 },
        tokens: { lower: 1_200_000, upper: 0, exact: 0, expiresAt: 1 },
      },
    },
  };
  const runtime = createProviderRateLearningRuntime({
    storage,
    policy: POLICY,
    now: () => 10_000,
    onTrace: event => traces.push(event),
  });
  const policy = await runtime.getPolicy({
    key: "expired|openai|https://expired.test/v1",
    sessionId: "session-stale",
    runId: "run-stale",
    spanId: "run-stale:llm:1",
  });
  assert.deepEqual(
    [policy.requestsPerWindow, policy.tokensPerWindow],
    [32, 1_500_000],
  );
  assert.deepEqual(
    [traces[0].phase, traces[0].staleDimensions, traces[0].sessionId, traces[0].runId, traces[0].spanId],
    ["evidence_stale", "requests,tokens", "session-stale", "run-stale", "run-stale:llm:1"],
  );
  assert.deepEqual(
    [traces[0].rpmAnchor, traces[0].tpmAnchor],
    [32, 1_500_000],
  );

  await runtime.getPolicy({ key: "expired|openai|https://expired.test/v1" });
  assert.equal(traces.length, 1, "the downgraded anchor must not repeatedly emit stale traces");
});

test("malformed persisted evidence still fails open to the configured floor", async () => {
  const storage = memoryStorage();
  storage.data[PROVIDER_RATE_LEARNING_STORAGE_KEY] = {
    version: 1,
    providers: {
      "malformed|openai|https://malformed.test/v1": { version: 99, tokens: "broken" },
    },
  };
  const runtime = createProviderRateLearningRuntime({ storage, policy: POLICY, now: () => 10_000 });
  const policy = await runtime.getPolicy({ key: "malformed|openai|https://malformed.test/v1" });
  assert.deepEqual(
    [policy.requestsPerWindow, policy.tokensPerWindow],
    [19, 980_000],
  );
});

test("storage failures never escape into the model request path", async () => {
  const traces = [];
  const runtime = createProviderRateLearningRuntime({
    storage: {
      async get() { throw new Error("read unavailable"); },
      async set() { throw new Error("write unavailable"); },
    },
    policy: POLICY,
    now: () => 1_000,
    onTrace: event => traces.push(event),
  });
  const policy = await runtime.getPolicy({ key: "safe|openai|https://safe.test/v1" });
  assert.equal(policy.tokensPerWindow, 980_000);
  await runtime.recordSuccess({
    key: "safe|openai|https://safe.test/v1",
    usage: { requests: 18, tokens: 900_000 },
    windowMs: 60_000,
  });
  await runtime.flush();
  assert.deepEqual(
    traces.filter(event => event.phase === "storage_error").map(event => event.action),
    ["load", "save"],
  );
});

function memoryStorage({ writeDelayMs = 0 } = {}) {
  const data = {};
  const storage = {
    data,
    setCalls: 0,
    async get(key) {
      return { [key]: structuredClone(data[key]) };
    },
    async set(values) {
      storage.setCalls += 1;
      if (writeDelayMs) await new Promise(resolve => setTimeout(resolve, writeDelayMs));
      Object.assign(data, structuredClone(values));
    },
  };
  return storage;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function afterMicrotasks(count) {
  while (count-- > 0) await Promise.resolve();
  return null;
}
