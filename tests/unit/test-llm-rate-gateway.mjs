import assert from "node:assert/strict";
import test from "node:test";

import { createLlmGateway } from "../../src/background/llm/index.js";
import { createProviderRateGovernor } from "../../src/background/llm/provider-rate-governor.js";
import { createProviderRateLearningRuntime } from "../../src/background/llm/provider-rate-runtime.js";
import { estimateTokens, estimateToolSchemaTokens } from "../../src/background/llm/token-accounting.js";

test("LLM gateway keeps request identity, uses the caller estimate, and settles non-stream usage", async () => {
  const rate = fakeRateGovernor();
  const gateway = createGateway(rate, {
    async chat() {
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 150 } };
    },
  });

  await gateway.chat(messages(), null, null, {
    inputTokensEstimate: 123,
    sessionId: "session-child",
    runId: "run-child",
    spanId: "run-child:llm:1",
  });
  assert.equal(rate.reservations[0].estimatedTokens, 123);
  assert.equal(rate.reservations[0].sessionId, "session-child");
  assert.equal(rate.reservations[0].runId, "run-child");
  assert.equal(rate.reservations[0].spanId, "run-child:llm:1");
  assert.deepEqual(rate.settlements, [{ id: "reservation-1", tokens: 150 }]);
});

test("LLM gateway falls back to the shared message and tool-schema estimate", async () => {
  const rate = fakeRateGovernor();
  const tools = [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }];
  const gateway = createGateway(rate, {
    async chat() {
      return { message: { role: "assistant", content: "ok" } };
    },
  });

  await gateway.chat(messages(), tools, null);
  assert.equal(
    rate.reservations[0].estimatedTokens,
    estimateTokens(messages()) + estimateToolSchemaTokens(tools),
  );
  assert.deepEqual(
    rate.settlements,
    [{ id: "reservation-1", tokens: 0 }],
    "a completed request remains successful evidence even when the provider omits usage",
  );
});

test("title-style calls can explicitly bypass provider admission", async () => {
  const rate = fakeRateGovernor();
  const gateway = createGateway(rate, {
    async chat() {
      return { message: { role: "assistant", content: "title" }, usage: { total_tokens: 20 } };
    },
  });

  await gateway.chat(messages(), null, null, { rateLimit: false });
  assert.equal(rate.reservations.length, 0);
  assert.equal(rate.settlements.length, 0);
});

test("disabled request limiting bypasses the governor as if it were absent", async () => {
  const rate = fakeRateGovernor();
  let waitFeedback = 0;
  const gateway = createGateway(rate, {
    async chat() {
      return { message: { role: "assistant", content: "direct" }, usage: { total_tokens: 20 } };
    },
  });

  const result = await gateway.chat(messages(), null, null, {
    config: { ...config(), requestRateLimit: false },
    sessionId: "session-direct",
    runId: "run-direct",
    spanId: "run-direct:llm:1",
    onRateWait() { waitFeedback += 1; },
  });

  assert.equal(result.message.content, "direct");
  assert.equal(rate.reservations.length, 0);
  assert.equal(rate.settlements.length, 0);
  assert.equal(waitFeedback, 0);
});

test("omitted request limiting defaults to bypassing the governor", async () => {
  const rate = fakeRateGovernor();
  const gateway = createGateway(rate);

  await gateway.chat(messages(), null, null, {
    config: { provider: "deepseek", model: "test", apiKey: "test-key" },
  });

  assert.equal(rate.reservations.length, 0);
  assert.equal(rate.settlements.length, 0);
});

test("each transport retry attempt receives a new reservation and only the successful attempt settles", async () => {
  const rate = fakeRateGovernor();
  const gateway = createGateway(rate, {
    async chat(_messages, _tools, _signal, options) {
      await options.onBeforeRetryAttempt({ attempt: 2 });
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 90 } };
    },
  });

  await gateway.chat(messages(), null, null, {
    sessionId: "session-retry",
    runId: "run-retry",
    spanId: "run-retry:llm:1",
  });
  assert.equal(rate.reservations.length, 2);
  assert.ok(rate.reservations.every(reservation => (
    reservation.sessionId === "session-retry"
    && reservation.runId === "run-retry"
    && reservation.spanId === "run-retry:llm:1"
  )), "transport retries should remain attributed to the same LLM span");
  assert.deepEqual(rate.settlements, [{ id: "reservation-2", tokens: 90 }]);
});

test("stream usage settles only after a normal done event", async () => {
  const completedRate = fakeRateGovernor();
  const completed = createGateway(completedRate, {
    async *chatStream() {
      yield { type: "usage", usage: { total_tokens: 70 } };
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  });
  for await (const _chunk of completed.chatStream(messages(), null, null)) {}
  assert.deepEqual(completedRate.settlements, [{ id: "reservation-1", tokens: 70 }]);

  const interruptedRate = fakeRateGovernor();
  const interrupted = createGateway(interruptedRate, {
    async *chatStream() {
      yield { type: "usage", usage: { total_tokens: 50 } };
      throw new Error("stream disconnected");
    },
  });
  await assert.rejects(async () => {
    for await (const _chunk of interrupted.chatStream(messages(), null, null)) {}
  }, error => error?.kind === "stream_protocol" && /stream disconnected/.test(error.message));
  assert.equal(interruptedRate.settlements.length, 0, "partial stream usage must not refund the reservation");
});

test("a provider Retry-After callback defers later sessions on the shared bucket", async () => {
  const clock = advancingClock();
  const starts = [];
  const adapter = {
    async chat(_messages, _tools, _signal, options, providerConfig) {
      starts.push({ sessionId: options.sessionId, provider: providerConfig.provider, at: clock.now() });
      if (options.sessionId === "session-a") {
        await options.onProviderBackoff({ status: 429, retryAfterMs: 5000 });
      }
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 10 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: createProviderRateGovernor({
      windowMs: 10_000,
      requestsPerWindow: 100,
      tokensPerWindow: 100_000,
      now: clock.now,
      wait: clock.wait,
    }),
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  await gateway.chat(messages(), null, null, {
    sessionId: "session-a",
    config: config("deepseek", "model-a"),
  });
  await gateway.chat(messages(), null, null, {
    sessionId: "session-c",
    config: config("bailian", "model-c"),
  });
  await gateway.chat(messages(), null, null, {
    sessionId: "session-b",
    config: config("deepseek", "model-b"),
  });

  assert.deepEqual(starts, [
    { sessionId: "session-a", provider: "deepseek", at: 0 },
    { sessionId: "session-c", provider: "bailian", at: 0 },
    { sessionId: "session-b", provider: "deepseek", at: 5000 },
  ]);
});

test("disabled request limiting does not install a provider backoff hook", async () => {
  const rate = fakeRateGovernor();
  let sawBackoffHook = false;
  const gateway = createGateway(rate, {
    async chat(_messages, _tools, _signal, options) {
      sawBackoffHook = typeof options.onProviderBackoff === "function";
      return { message: { role: "assistant", content: "direct" } };
    },
  });

  await gateway.chat(messages(), null, null, {
    config: { ...config(), requestRateLimit: false },
  });
  assert.equal(sawBackoffHook, false);
  assert.equal(rate.backoffs.length, 0);
});

test("disabled limiting never holds a completed response behind learning storage", async () => {
  const pendingLoad = deferred();
  const pendingSave = deferred();
  let saveStarted = false;
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      await options.onProviderResponse({
        status: 200,
        ok: true,
        headers: new Headers({ "x-ratelimit-limit-requests": "30" }),
      });
      return { message: { role: "assistant", content: "direct" }, usage: { total_tokens: 980_000 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const makeGateway = storage => createLlmGateway({
    rateGovernor: createProviderRateGovernor(),
    rateLearningStorage: storage,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async () => ({ ...config(), requestRateLimit: false }),
  });

  const loading = makeGateway({
    get: () => pendingLoad.promise,
    async set() {},
  }).chat(messages());
  const loadedResult = await Promise.race([loading, afterMicrotasks(20)]);
  assert.equal(loadedResult?.message?.content, "direct");
  pendingLoad.resolve({});

  const saving = makeGateway({
    async get() { return {}; },
    set() {
      saveStarted = true;
      return pendingSave.promise;
    },
  }).chat(messages(), null, null, { inputTokensEstimate: 980_000 });
  const savedResult = await Promise.race([saving, afterMicrotasks(20)]);
  assert.equal(savedResult?.message?.content, "direct");
  await afterMicrotasks(10);
  assert.equal(saveStarted, true, "learning may persist in the background after returning the model response");
  pendingSave.resolve();
});

test("provider buckets ignore session and model but separate providers", async () => {
  const rate = fakeRateGovernor();
  const gateway = createGateway(rate, {
    async chat() {
      return { message: { role: "assistant", content: "ok" } };
    },
  });

  await gateway.chat(messages(), null, null, { sessionId: "one", config: config("deepseek", "model-a") });
  await gateway.chat(messages(), null, null, { sessionId: "two", config: config("deepseek", "model-b") });
  await gateway.chat(messages(), null, null, { sessionId: "three", config: config("deepseek", "model-c", "other-key") });
  await gateway.chat(messages(), null, null, { sessionId: "four", config: config("bailian", "model-d") });

  assert.equal(rate.reservations[0].key, rate.reservations[1].key);
  assert.notEqual(rate.reservations[1].key, rate.reservations[2].key);
  assert.notEqual(rate.reservations[1].key, rate.reservations[3].key);
  assert.ok(rate.reservations.every(({ key }) => !key.includes("test-key") && !key.includes("other-key")));
});

test("concurrent sessions share one provider queue while another provider remains independent", async () => {
  const clock = controlledClock();
  const starts = [];
  const rateEvents = [];
  const adapter = {
    async chat(_messages, _tools, _signal, options, providerConfig) {
      starts.push({ sessionId: options.sessionId, provider: providerConfig.provider, at: clock.now() });
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 10 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: createProviderRateGovernor({
      windowMs: 1000,
      requestsPerWindow: 2,
      tokensPerWindow: 1000,
      now: clock.now,
      wait: clock.wait,
      onTrace: event => rateEvents.push(event),
    }),
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  const first = gateway.chat(messages(), null, null, {
    sessionId: "session-a",
    runId: "run-a",
    spanId: "run-a:llm:1",
    config: config("deepseek", "model-a"),
    inputTokensEstimate: 10,
  });
  const second = gateway.chat(messages(), null, null, {
    sessionId: "session-b",
    runId: "run-b",
    spanId: "run-b:llm:1",
    config: config("deepseek", "model-b"),
    inputTokensEstimate: 10,
  });
  const independent = gateway.chat(messages(), null, null, {
    sessionId: "session-c",
    runId: "run-c",
    spanId: "run-c:llm:1",
    config: config("bailian", "model-c"),
    inputTokensEstimate: 10,
  });

  await Promise.all([first, independent]);
  assert.deepEqual(starts, [
    { sessionId: "session-a", provider: "deepseek", at: 0 },
    { sessionId: "session-c", provider: "bailian", at: 0 },
  ]);
  const queuedWait = await clock.nextWait();
  assert.equal(queuedWait.ms, 500);
  queuedWait.release();
  await second;
  assert.deepEqual(starts[2], { sessionId: "session-b", provider: "deepseek", at: 500 });
  const admitted = rateEvents.filter(event => event.phase === "admitted");
  assert.deepEqual(
    admitted.map(event => [event.sessionId, event.runId, event.spanId]).sort(),
    [
      ["session-a", "run-a", "run-a:llm:1"],
      ["session-b", "run-b", "run-b:llm:1"],
      ["session-c", "run-c", "run-c:llm:1"],
    ],
    "shared provider accounting must retain each concurrent session's identity",
  );
});

test("the default governor records rolling RPM and TPM in debug trace", async () => {
  const adapter = {
    async chat() {
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 150 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const previousDebug = globalThis.__qzDebug;
  globalThis.__qzDebug = { enabled: true, logs: [] };
  try {
    const gateway = createLlmGateway({
      adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
      resolveConfig: async () => config(),
    });
    await gateway.chat(messages(), null, null, {
      inputTokensEstimate: 123,
      sessionId: "session-debug",
      runId: "run-debug",
      spanId: "run-debug:llm:1",
    });

    const rateLogs = globalThis.__qzDebug.logs.filter(line => line.includes("provider_rate"));
    assert.match(rateLogs[0], /phase=admitted provider=deepseek sessionId=session-debug runId=run-debug spanId=run-debug:llm:1 rpm=1 rpmLimit=19 tpm=123 tpmLimit=980000/);
    assert.match(rateLogs[1], /phase=settled provider=deepseek sessionId=session-debug runId=run-debug spanId=run-debug:llm:1 rpm=1 rpmLimit=19 tpm=123 tpmLimit=980000 tokenUnit=estimated estimatedTokens=123 reportedTokens=150/);
  } finally {
    if (previousDebug === undefined) delete globalThis.__qzDebug;
    else globalThis.__qzDebug = previousDebug;
  }
});

test("reported provider usage cannot erase a successful virtual-capacity probe", async () => {
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 10,
    tokensPerWindow: 1000,
  });
  const learning = createProviderRateLearningRuntime({ governor });
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: {
      openai: {
        async chat() {
          return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 100 } };
        },
        async *chatStream() {},
      },
    },
    resolveConfig: async () => config(),
  });

  await gateway.chat(messages(), null, null, { inputTokensEstimate: 950 });
  await afterMicrotasks(10);

  assert.equal(governor.getUsage(providerBucketKey()).tokens, 950);
  assert.equal(
    (await learning.getPolicy({ key: providerBucketKey() })).tokensPerWindow,
    1188,
    "a successful near-boundary estimate should raise the virtual capacity despite smaller reported usage",
  );
});

test("disabled limiting observes without waiting and later reuses learned capacity", async () => {
  const clock = advancingClock();
  const starts = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
  });
  const learning = createProviderRateLearningRuntime({
    governor,
    now: clock.now,
  });
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      starts.push({ sessionId: options.sessionId, at: clock.now() });
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 450 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  for (const sessionId of ["observe-a", "observe-b"]) {
    await gateway.chat(messages(), null, null, {
      sessionId,
      inputTokensEstimate: 450,
      config: { ...config(), requestRateLimit: false },
    });
  }
  await gateway.chat(messages(), null, null, {
    sessionId: "enforced",
    inputTokensEstimate: 100,
    config: config(),
  });

  assert.deepEqual(starts, [
    { sessionId: "observe-a", at: 0 },
    { sessionId: "observe-b", at: 0 },
    { sessionId: "enforced", at: 800 },
  ]);
});

test("a trusted probe failure lowers the next retry policy and traces its request identity", async () => {
  const clock = advancingClock();
  const rateEvents = [];
  const learningEvents = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => rateEvents.push(event),
  });
  const learning = createProviderRateLearningRuntime({
    governor,
    now: clock.now,
    onTrace: event => learningEvents.push(event),
  });
  const key = providerBucketKey();
  await learning.recordSuccess({
    key,
    usage: { requests: 2, tokens: 100 },
    windowMs: 1000,
  });
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      await options.onProviderResponse({
        status: 429,
        ok: false,
        code: "RPM_RATE_LIMIT",
        kind: "transient",
      });
      await options.onBeforeRetryAttempt({ attempt: 2 });
      return { message: { role: "assistant", content: "recovered" }, usage: { total_tokens: 100 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  const result = await gateway.chat(messages(), null, null, {
    sessionId: "session-probe",
    runId: "run-probe",
    spanId: "run-probe:llm:1",
    inputTokensEstimate: 100,
    config: config(),
  });
  assert.equal(result.message.content, "recovered");
  assert.deepEqual(
    rateEvents.filter(event => event.phase === "admitted").map(event => [event.waitedMs, event.rpmLimit]),
    [[0, 3], [500, 2]],
  );
  const signal = learningEvents.find(event => event.signal === "rate_limit");
  assert.deepEqual(
    [signal.sessionId, signal.runId, signal.spanId, signal.trusted, signal.oldRpmLimit, signal.rpmLimit],
    ["session-probe", "run-probe", "run-probe:llm:1", true, 3, 2],
  );
});

test("two opaque 429s tighten the shared policy before the next retry", async () => {
  const clock = advancingClock();
  const rateEvents = [];
  const learningEvents = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => rateEvents.push(event),
  });
  const learning = createProviderRateLearningRuntime({
    governor,
    now: clock.now,
    onTrace: event => learningEvents.push(event),
  });
  await learning.recordProviderSignal({
    key: providerBucketKey(),
    status: 200,
    headers: { "x-ratelimit-limit-requests": "4", "x-ratelimit-limit-tokens": "2000" },
  });
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      for (const attempt of [2, 3]) {
        await options.onProviderResponse({ status: 429, ok: false, kind: "transient" });
        await options.onBeforeRetryAttempt({ attempt });
      }
      return { message: { role: "assistant", content: "recovered" }, usage: { total_tokens: 100 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  const result = await gateway.chat(messages(), null, null, {
    sessionId: "session-opaque",
    runId: "run-opaque",
    spanId: "run-opaque:llm:1",
    inputTokensEstimate: 100,
    config: config(),
  });
  assert.equal(result.message.content, "recovered");
  assert.deepEqual(
    rateEvents.filter(event => event.phase === "admitted").map(event => event.rpmLimit),
    [4, 4, 3],
  );
  assert.deepEqual(
    learningEvents.filter(event => event.signal === "rate_limit").map(event => [
      event.trusted,
      event.pressurePct,
      event.pressureLowerPct,
      event.pressureUpperPct,
      event.sessionId,
    ]),
    [
      [false, 100, 0, 0, "session-opaque"],
      [false, 80, 0, 100, "session-opaque"],
    ],
  );
  assert.equal((await learning.getPolicy({ key: providerBucketKey() })).requestsPerWindow, 3);
});

test("disabled limiting learns dimensionless bounds without waiting and reuses them when enabled", async () => {
  const clock = advancingClock();
  const starts = [];
  const rateEvents = [];
  const learningEvents = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => rateEvents.push(event),
  });
  const learning = createProviderRateLearningRuntime({
    governor,
    now: clock.now,
    onTrace: event => learningEvents.push(event),
  });
  await learning.recordProviderSignal({
    key: providerBucketKey(),
    status: 200,
    headers: { "x-ratelimit-limit-requests": "4", "x-ratelimit-limit-tokens": "2000" },
  });
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      starts.push({ sessionId: options.sessionId, at: clock.now() });
      if (options.sessionId === "observe-opaque") {
        for (const attempt of [2, 3]) {
          await options.onProviderResponse({
            status: 429,
            ok: false,
            code: "rate_limit_reached",
            kind: "transient",
          });
          await options.onBeforeRetryAttempt({ attempt });
        }
      }
      return { message: { role: "assistant", content: "ok" }, usage: { total_tokens: 100 } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  await gateway.chat(messages(), null, null, {
    sessionId: "observe-opaque",
    inputTokensEstimate: 100,
    config: { ...config(), requestRateLimit: false },
  });
  assert.deepEqual(starts, [{ sessionId: "observe-opaque", at: 0 }]);
  assert.equal(rateEvents.length, 0, "passive observation must not emit queue/admission trace or wait");
  assert.deepEqual(
    learningEvents.filter(event => event.signal === "rate_limit").map(event => [
      event.pressurePct,
      event.pressureLowerPct,
      event.pressureUpperPct,
    ]),
    [[100, 0, 0], [80, 0, 100]],
  );

  await gateway.chat(messages(), null, null, {
    sessionId: "enforce-learned",
    inputTokensEstimate: 100,
    config: config(),
  });
  assert.deepEqual(starts.at(-1), { sessionId: "enforce-learned", at: 1000 });
  assert.equal(rateEvents.find(event => event.phase === "admitted")?.rpmLimit, 3);
});

test("stream-body provider errors enter learning once even without an HTTP error response", async () => {
  const events = [];
  const governor = createProviderRateGovernor();
  const learning = createProviderRateLearningRuntime({
    governor,
    onTrace: event => events.push(event),
  });
  const providerError = Object.assign(new Error("provider stream error"), {
    status: 429,
    code: "TPM_RATE_LIMIT",
  });
  const adapter = {
    async chat() {
      return { message: { role: "assistant", content: "ok" } };
    },
    async *chatStream() {
      throw providerError;
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  await assert.rejects(async () => {
    for await (const _chunk of gateway.chatStream(messages(), null, null, {
      sessionId: "session-stream-rate",
      runId: "run-stream-rate",
      spanId: "run-stream-rate:llm:1",
      inputTokensEstimate: 100,
      config: config(),
    })) {}
  }, error => error?.status === 429 && error?.code === "TPM_RATE_LIMIT");
  const signals = events.filter(event => event.signal === "rate_limit");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, "gateway_error");
  assert.equal(signals[0].spanId, "run-stream-rate:llm:1");
});

test("a prior retry attempt cannot mask a later stream-body rate failure", async () => {
  const events = [];
  const governor = createProviderRateGovernor();
  const learning = createProviderRateLearningRuntime({
    governor,
    onTrace: event => events.push(event),
  });
  const providerError = Object.assign(new Error("provider stream error"), {
    status: 429,
    code: "resource_exhausted",
    kind: "transient",
  });
  const adapter = {
    async chat() {
      return { message: { role: "assistant", content: "ok" } };
    },
    async *chatStream(_messages, _tools, _signal, options) {
      await options.onProviderResponse({
        status: 429,
        ok: false,
        code: "resource_exhausted",
        kind: "transient",
      });
      await options.onBeforeRetryAttempt({ attempt: 2 });
      throw providerError;
    },
  };
  const gateway = createLlmGateway({
    rateGovernor: governor,
    rateLearning: learning,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config,
  });

  await assert.rejects(async () => {
    for await (const _chunk of gateway.chatStream(messages(), null, null, {
      sessionId: "session-retry-stream",
      config: config(),
    })) {}
  }, error => error?.status === 429 && error?.code === "resource_exhausted");
  assert.deepEqual(
    events.filter(event => event.signal === "rate_limit").map(event => [
      event.source,
      event.pressurePct,
      event.pressureStreak,
    ]),
    [
      ["transport", 100, 1],
      ["gateway_error", 80, 2],
    ],
  );
});

test("default learning trace includes provider and session/run/span identity", async () => {
  const previousDebug = globalThis.__qzDebug;
  globalThis.__qzDebug = { enabled: true, logs: [] };
  const governor = createProviderRateGovernor();
  const adapter = {
    async chat(_messages, _tools, _signal, options) {
      await options.onProviderResponse({
        status: 429,
        ok: false,
        code: "RPM_RATE_LIMIT",
        kind: "transient",
      });
      return { message: { role: "assistant", content: "ok" } };
    },
    async *chatStream() {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    },
  };
  try {
    const gateway = createLlmGateway({
      rateGovernor: governor,
      adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
      resolveConfig: async options => options.config,
    });
    await gateway.chat(messages(), null, null, {
      sessionId: "session-learning-trace",
      runId: "run-learning-trace",
      spanId: "run-learning-trace:llm:1",
      config: config(),
    });
    const line = globalThis.__qzDebug.logs.find(value => value.includes("provider_rate_learning"));
    assert.match(line, /phase=signal provider=deepseek/);
    assert.match(line, /sessionId=session-learning-trace runId=run-learning-trace spanId=run-learning-trace:llm:1/);
    assert.match(line, /signal=rate_limit dimension=requests trusted=true/);
    assert.match(line, /rpmAnchor=19 rpmLower=0 rpmUpper=1 rpmExact=0/);
    assert.match(line, /tpmAnchor=0 tpmLower=0 tpmUpper=0 tpmExact=0/);
    assert.match(line, /pressurePct=100 pressureLowerPct=0 pressureUpperPct=0 pressureStreak=0/);
    assert.match(line, /floorRpm=19 floorTpm=980000/);
  } finally {
    if (previousDebug === undefined) delete globalThis.__qzDebug;
    else globalThis.__qzDebug = previousDebug;
  }
});

function createGateway(rateGovernor, openai = {}) {
  const adapter = {
    chat: openai.chat || (async () => ({ message: { role: "assistant", content: "ok" } })),
    chatStream: openai.chatStream || (async function* () {
      yield { type: "done", message: { role: "assistant", content: "ok" } };
    }),
  };
  return createLlmGateway({
    rateGovernor,
    adapters: { openai: adapter, anthropic: adapter, "openai-codex": adapter },
    resolveConfig: async options => options.config || config(),
  });
}

function fakeRateGovernor() {
  const reservations = [];
  const settlements = [];
  const backoffs = [];
  return {
    reservations,
    settlements,
    backoffs,
    async reserve(input) {
      const reservation = { ...input, id: `reservation-${reservations.length + 1}` };
      reservations.push(reservation);
      return reservation;
    },
    settle(id, tokens) {
      settlements.push({ id, tokens });
      return true;
    },
    applyRetryAfter(event) {
      backoffs.push(event);
      return true;
    },
  };
}

function config(provider = "deepseek", model = "test", apiKey = "test-key") {
  return { provider, model, apiKey, requestRateLimit: true };
}

function providerBucketKey(apiKey = "test-key") {
  let hash = 2166136261;
  for (let index = 0; index < apiKey.length; index += 1) {
    hash ^= apiKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `deepseek|openai|https://api.deepseek.com/chat/completions|key-${(hash >>> 0).toString(36)}`;
}

function messages() {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ];
}

function controlledClock() {
  let time = 0;
  const pending = [];
  const observers = [];
  return {
    now: () => time,
    wait: ms => new Promise(resolve => {
      const item = {
        ms,
        release() {
          time += ms;
          resolve();
        },
      };
      pending.push(item);
      observers.splice(0).forEach(notify => notify());
    }),
    async nextWait() {
      while (!pending.length) await new Promise(resolve => observers.push(resolve));
      return pending.shift();
    },
  };
}

function advancingClock() {
  let time = 0;
  return {
    now: () => time,
    wait: async ms => { time += ms; },
  };
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
