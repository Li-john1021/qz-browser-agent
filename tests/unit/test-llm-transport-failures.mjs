import assert from "node:assert/strict";
import {
  fetchLlmEndpointWithRetry,
  LLM_RETRY_DEFAULT_MAX_RETRIES,
  readWithIdleTimeout,
  withTimeout,
} from "../../src/background/llm/transport.js";

const originalFetch = globalThis.fetch;

try {
  await retriesTransientHttpFailures();
  await reportsEffectiveRetryAfterBeforeRetrying();
  await capsPathologicalProviderBackoff();
  await usesLearnedRetryDelayWhenProviderOmitsIt();
  await sharesOnlyExplicitLearnedProviderBackoff();
  await doesNotRetryQuotaFailures();
  await stopsAtTheConfiguredAttemptBudget();
  await usesOneDefaultExponentialRetryBudget();
  await abortsDuringRetryBackoff();
  await doesNotRetryAfterOpenTimeout();
  await streamIdleAndAbortReleaseTheReader();
  await preAbortedStreamDoesNotReadAndHandlesCancelRejection();
  console.log("LLM transport failure tests passed");
} finally {
  globalThis.fetch = originalFetch;
}

async function retriesTransientHttpFailures() {
  const responses = [
    new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: { "retry-after-ms": "2500" } }),
    new Response("ok", { status: 200 }),
  ];
  const retries = [];
  const backoffs = [];
  const attempts = [];
  globalThis.fetch = async () => responses.shift();
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    onRetry: event => retries.push(event),
    onProviderBackoff: event => backoffs.push(event),
    onBeforeRetryAttempt: event => attempts.push(event),
  });
  assert.equal(await response.text(), "ok");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].retryAfterMs, 2500);
  assert.equal(backoffs[0].retryAfterMs, 2500, "an explicit overload cooldown should apply across the provider");
  assert.match(retries[0].reason, /暂时不可用/);
  assert.match(retries[0].reason, /overloaded/);
  assert.deepEqual(attempts.map(event => event.attempt), [2]);
}

async function reportsEffectiveRetryAfterBeforeRetrying() {
  const responses = [
    new Response('{"error":{"code":"RateLimitExceeded","message":"private rate detail"}}', {
      status: 429,
      headers: { "retry-after-ms": "2500" },
    }),
    new Response("ok", { status: 200 }),
  ];
  const retries = [];
  const backoffs = [];
  globalThis.fetch = async () => responses.shift();
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 5, jitterRatio: 0 },
    onRetry: event => retries.push(event),
    onProviderBackoff: event => backoffs.push(event),
  });

  assert.equal(await response.text(), "ok");
  assert.equal(retries[0].retryAfterMs, 2500, "the provider cooldown must preserve the server instruction");
  assert.equal(retries[0].delayMs, 5);
  assert.deepEqual(
    backoffs.map(event => [event.status, event.retryAfterMs, event.code]),
    [[429, 2500, "RateLimitExceeded"]],
  );
  assert.match(retries[0].reason, /private rate detail/);
}

async function capsPathologicalProviderBackoff() {
  const responses = [
    new Response('{"error":{"code":"RateLimitExceeded"}}', {
      status: 429,
      headers: { "retry-after-ms": "999999999" },
    }),
    new Response("ok", { status: 200 }),
  ];
  const retries = [];
  const backoffs = [];
  globalThis.fetch = async () => responses.shift();
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    onRetry: event => retries.push(event),
    onProviderBackoff: event => backoffs.push(event),
  });

  assert.equal(await response.text(), "ok");
  assert.equal(retries[0].retryAfterMs, 300_000);
  assert.equal(backoffs[0].retryAfterMs, 300_000);
}

async function usesLearnedRetryDelayWhenProviderOmitsIt() {
  const responses = [
    new Response('{"error":{"code":"RateLimitExceeded"}}', { status: 429 }),
    new Response("ok", { status: 200 }),
  ];
  const providerResponses = [];
  const retries = [];
  globalThis.fetch = async () => responses.shift();
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 5, jitterRatio: 0 },
    onProviderResponse: event => {
      providerResponses.push(event.status);
      return event.status === 429 ? { retryAfterMs: 2000 } : null;
    },
    onRetry: event => retries.push(event),
  });

  assert.equal(await response.text(), "ok");
  assert.deepEqual(providerResponses, [429, 200]);
  assert.equal(retries[0].retryAfterMs, 2000);
  assert.equal(retries[0].delayMs, 5, "the existing transport cap still bounds the physical test wait");
}

async function sharesOnlyExplicitLearnedProviderBackoff() {
  const responses = [
    new Response('{"error":{"code":"RateLimitExceeded"}}', {
      status: 429,
      headers: { "retry-after": "9" },
    }),
    new Response("ok", { status: 200 }),
  ];
  const backoffs = [];
  globalThis.fetch = async () => responses.shift();
  await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    onProviderResponse: event => event.status === 429
      ? { retryAfterMs: 2000, providerRetryAfterMs: 7000 }
      : null,
    onProviderBackoff: event => backoffs.push(event),
  });

  assert.equal(backoffs[0]?.retryAfterMs, 9000, "callbacks must not shorten an explicit provider cooldown");
}

async function doesNotRetryQuotaFailures() {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":{"code":"insufficient_quota","message":"quota exhausted","type":"insufficient_quota"}}', { status: 429 });
  };
  const response = await fetchLlmEndpointWithRetry(config(), "chat", { method: "POST" }, {
    retry: { maxRetries: 5, baseDelayMs: 0, maxDelayMs: 0 },
  });
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
  assert.match(await response.text(), /insufficient_quota/);
}

async function stopsAtTheConfiguredAttemptBudget() {
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":{"code":"service_unavailable"}}', { status: 503 });
  };
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 },
    onRetry: event => retries.push(event),
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
  assert.deepEqual(retries.map(event => event.delayMs), [1, 2], "a missing Retry-After must fall back to exponential delay");
}

async function usesOneDefaultExponentialRetryBudget() {
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= LLM_RETRY_DEFAULT_MAX_RETRIES) throw new TypeError("Failed to fetch");
    return new Response("ok", { status: 200 });
  };
  const response = await fetchLlmEndpointWithRetry(config(), "stream", { method: "POST" }, {
    retry: { baseDelayMs: 1, maxDelayMs: 100, jitterRatio: 0 },
    onRetry: event => retries.push(event),
  });
  assert.equal(LLM_RETRY_DEFAULT_MAX_RETRIES, 5);
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 6, "the initial request and five retries must share the default transport budget");
  assert.deepEqual(retries.map(event => event.delayMs), [1, 2, 4, 8, 16]);
}

async function abortsDuringRetryBackoff() {
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("overloaded", { status: 503 });
  };
  await assert.rejects(
    fetchLlmEndpointWithRetry(config(), "stream", { method: "POST", signal: controller.signal }, {
      retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1000 },
      onRetry: () => controller.abort(),
    }),
    error => error?.name === "AbortError",
  );
  assert.equal(calls, 1);
}

async function doesNotRetryAfterOpenTimeout() {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(init.signal.reason || new DOMException("Aborted", "AbortError"));
      if (init.signal.aborted) rejectAbort();
      else init.signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  const timeout = withTimeout(null, 10);
  try {
    await assert.rejects(
      fetchLlmEndpointWithRetry(config(), "stream", { method: "POST", signal: timeout.signal }, {
        retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      error => /timed out/.test(error?.message || ""),
    );
  } finally {
    timeout.cleanup();
  }
  assert.equal(calls, 1, "a request that already consumed its full open-timeout must fail without another attempt");
}

async function streamIdleAndAbortReleaseTheReader() {
  const completed = await readWithIdleTimeout({ read: async () => ({ done: true }) }, 50);
  assert.equal(completed.done, true);

  let idleCancelled = 0;
  const idleReader = {
    read: () => new Promise(() => {}),
    cancel: () => { idleCancelled += 1; },
  };
  await assert.rejects(
    readWithIdleTimeout(idleReader, 10),
    error => error?.name === "TimeoutError",
  );
  assert.equal(idleCancelled, 1);

  let abortCancelled = 0;
  const abortReader = {
    read: () => new Promise(() => {}),
    cancel: () => { abortCancelled += 1; },
  };
  const controller = new AbortController();
  const pending = readWithIdleTimeout(abortReader, 1000, controller.signal);
  controller.abort("user stop");
  await assert.rejects(pending, error => error?.name === "AbortError");
  assert.equal(abortCancelled, 1);
}

function config() {
  return { provider: "custom", providerLabel: "Custom", model: "test", endpoint: "https://llm.test/v1" };
}

async function preAbortedStreamDoesNotReadAndHandlesCancelRejection() {
  const controller = new AbortController();
  controller.abort("already stopped");
  let cancelled = 0;
  await assert.rejects(readWithIdleTimeout({
    read() { throw new Error("a stopped stream must not start another read"); },
    cancel(reason) { cancelled++; assert.equal(reason, "already stopped"); return Promise.reject(new Error("reader already closed")); },
  }, 10000, controller.signal), { name: "AbortError" });
  assert.equal(cancelled, 1);
  await new Promise(resolve => setImmediate(resolve));
}
