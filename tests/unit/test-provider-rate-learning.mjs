import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderRateSignal,
  reduceProviderRateLearning,
} from "../../src/background/llm/provider-rate-learning.js";

const POLICY = Object.freeze({
  windowMs: 60_000,
  requestsPerWindow: 19,
  tokensPerWindow: 980_000,
});

test("provider rate signals prefer structured codes and headers over generic HTTP status", () => {
  const cases = [
    {
      name: "Alibaba allocation quota is account quota, not a learned rate boundary",
      input: { status: 429, kind: "quota", code: "Throttling.AllocationQuota" },
      expected: { type: "quota", dimension: "unknown", trusted: false },
    },
    {
      name: "Alibaba rate quota is an explicit but dimensionless rate boundary",
      input: { status: 429, code: "Throttling.RateQuota" },
      expected: { type: "rate_limit", dimension: "unknown", trusted: true },
    },
    {
      name: "OpenAI-compatible TPM code identifies tokens",
      input: { status: 429, code: "tokens_rate_limit_exceeded" },
      expected: { type: "rate_limit", dimension: "tokens", trusted: true },
    },
    {
      name: "Kimi OpenAI-compatible code is explicit without inventing a dimension",
      input: { status: 429, code: "rate_limit_reached" },
      expected: { type: "rate_limit", dimension: "unknown", trusted: true },
    },
    {
      name: "RPM code identifies requests",
      input: { status: 429, code: "requests_rate_limit_reached" },
      expected: { type: "rate_limit", dimension: "requests", trusted: true },
    },
    {
      name: "generic 429 is temporary evidence only",
      input: { status: 429, code: "resource_exhausted" },
      expected: { type: "rate_limit", dimension: "unknown", trusted: false },
    },
    {
      name: "opaque MiniMax numeric code is not guessed from its number",
      input: { status: 429, code: "1002" },
      expected: { type: "rate_limit", dimension: "unknown", trusted: false },
    },
    {
      name: "a prose-derived quota kind cannot override an opaque structured code",
      input: { status: 429, kind: "quota", code: "LLM_PROVIDER_RESPONSE_ERROR" },
      expected: { type: "rate_limit", dimension: "unknown", trusted: false },
    },
    {
      name: "context overflow wins over a misleading HTTP 429",
      input: { status: 429, kind: "context_overflow", code: "context_length_exceeded" },
      expected: { type: "none", dimension: "unknown", trusted: false },
    },
    {
      name: "authentication wins over a misleading HTTP 429",
      input: { status: 429, kind: "auth", code: "invalid_api_key" },
      expected: { type: "none", dimension: "unknown", trusted: false },
    },
    {
      name: "content policy wins over a misleading HTTP 429",
      input: { status: 429, kind: "content_filter", code: "content_filter" },
      expected: { type: "none", dimension: "unknown", trusted: false },
    },
    {
      name: "provider outage is not a capacity observation",
      input: { status: 503, code: "server_is_overloaded" },
      expected: { type: "overload", dimension: "unknown", trusted: false },
    },
    {
      name: "structured overload also wins over a misleading HTTP 429",
      input: { status: 429, kind: "transient", code: "server_is_overloaded" },
      expected: { type: "overload", dimension: "unknown", trusted: false },
    },
    {
      name: "auth failures are irrelevant to rate learning",
      input: { status: 401, code: "invalid_api_key" },
      expected: { type: "none", dimension: "unknown", trusted: false },
    },
  ];

  for (const item of cases) {
    const signal = parseProviderRateSignal({ ...item.input, now: 10_000 });
    assert.deepEqual(
      { type: signal.type, dimension: signal.dimension, trusted: signal.trusted },
      item.expected,
      item.name,
    );
  }
});

test("rate headers normalize OpenAI and Anthropic limits, remaining values, and reset formats", () => {
  const openAi = parseProviderRateSignal({
    status: 200,
    now: 1_000,
    headers: {
      "X-RateLimit-Limit-Requests": "120",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1m30s",
      "x-ratelimit-limit-tokens": "2000000",
      "x-ratelimit-remaining-tokens": "10",
      "x-ratelimit-reset-tokens": "2.5s",
    },
  });
  assert.equal(openAi.type, "limits");
  assert.deepEqual(openAi.limits, {
    requests: { limit: 120, remaining: 0, resetAt: 91_000 },
    tokens: { limit: 2_000_000, remaining: 10, resetAt: 3_500 },
  });

  const anthropic = parseProviderRateSignal({
    status: 429,
    now: Date.parse("2026-07-22T10:00:00Z"),
    headers: new Headers({
      "anthropic-ratelimit-requests-limit": "60",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-07-22T10:00:05Z",
    }),
  });
  assert.equal(anthropic.dimension, "requests");
  assert.equal(anthropic.trusted, true);
  assert.equal(anthropic.retryAt, Date.parse("2026-07-22T10:00:05Z"));

  const anthropicTokens = parseProviderRateSignal({
    status: 429,
    now: 1_000,
    headers: {
      "anthropic-ratelimit-tokens-limit": "2000000",
      "anthropic-ratelimit-tokens-remaining": "0",
      "anthropic-ratelimit-tokens-reset": "3s",
    },
  });
  assert.equal(anthropicTokens.dimension, "tokens");
  assert.equal(anthropicTokens.retryAt, 4_000);
});

test("Retry-After supports milliseconds, seconds, and dates without consulting a hidden clock", () => {
  assert.equal(parseProviderRateSignal({
    status: 429,
    now: 100,
    headers: { "retry-after-ms": "1250" },
  }).retryAt, 1350);
  assert.equal(parseProviderRateSignal({
    status: 429,
    now: 100,
    headers: { "retry-after": "2.5" },
  }).retryAt, 2600);
  assert.equal(parseProviderRateSignal({
    status: 503,
    now: Date.parse("2026-07-22T10:00:00Z"),
    headers: { "retry-after": "Wed, 22 Jul 2026 10:00:07 GMT" },
  }).retryAt, Date.parse("2026-07-22T10:00:07Z"));
});

test("ordinary traffic stays allocation-stable and produces no policy or cooldown", () => {
  const signal = parseProviderRateSignal({ status: 200, now: 0 });
  let first = null;
  for (let index = 0; index < 100_000; index += 1) {
    const result = reduceProviderRateLearning(null, {
      outcome: "success",
      signal,
      usage: {
        requests: index % 10,
        tokens: (index * 7919) % 400_000,
      },
      windowMs: POLICY.windowMs,
    }, { now: index, policy: POLICY });
    first ||= result;
    assert.equal(result, first, "the cold normal path should reuse the singleton no-op result");
  }
  assert.deepEqual(first, {
    state: null,
    policy: null,
    retryAt: 0,
    changed: false,
  });
});

test("the pure learner requires the caller's current policy instead of owning a duplicate default", () => {
  assert.throws(
    () => reduceProviderRateLearning(null, { outcome: "success" }, { now: 0 }),
    /fallback policy is required/,
  );
});

test("an absurd Retry-After cannot strand the provider indefinitely", () => {
  const signal = parseProviderRateSignal({
    status: 429,
    now: 1000,
    headers: { "retry-after": "999999999" },
  });
  const result = reduceProviderRateLearning(null, {
    outcome: "failure",
    signal,
  }, { now: 1000, policy: POLICY });
  assert.equal(result.retryAt, 301_000);
  assert.equal(result.state.pressure.scale, 100);
  assert.equal(result.state.pressure.streak, 1);
});

test("advertised request limits take effect while token limits stay in the virtual coordinate", () => {
  const signal = parseProviderRateSignal({
    status: 200,
    now: 0,
    headers: {
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-limit-tokens": "2000000",
    },
  });
  const learned = reduceProviderRateLearning(null, {
    outcome: "success",
    signal,
    usage: { requests: 1, tokens: 1000 },
  }, { now: 0, policy: POLICY });
  assert.deepEqual(learned.policy, {
    windowMs: 60_000,
    requestsPerWindow: 100,
    tokensPerWindow: 980_000,
  });
  assert.equal(learned.state.tokens, null);

  const repeated = reduceProviderRateLearning(learned.state, {
    outcome: "success",
    signal,
    usage: { requests: 2, tokens: 2000 },
  }, { now: 60_000, policy: POLICY });
  assert.equal(repeated.state, learned.state);
  assert.equal(repeated.changed, false);
});

test("an isolated opaque 429 and provider outages do not lower learned capacity", () => {
  const seed = reduceProviderRateLearning(null, {
    outcome: "success",
    usage: { requests: 18, tokens: 950_000 },
  }, { now: 0, policy: POLICY });
  const stateSnapshot = structuredClone(seed.state);
  const opaque = reduceProviderRateLearning(seed.state, {
    outcome: "failure",
    signal: parseProviderRateSignal({ status: 429, code: "resource_exhausted", now: 10 }),
    usage: { requests: 19, tokens: 980_000 },
  }, { now: 10, policy: POLICY });
  assert.deepEqual(opaque.policy, seed.policy);
  assert.equal(opaque.state.pressure.scale, 100);
  assert.equal(opaque.state.pressure.streak, 1);
  assert.equal(opaque.retryAt, 2010);
  assert.equal(opaque.state.requests, seed.state.requests);
  assert.equal(opaque.state.tokens, seed.state.tokens);

  const overload = reduceProviderRateLearning(seed.state, {
    outcome: "failure",
    signal: parseProviderRateSignal({ status: 503, code: "server_is_overloaded", now: 20 }),
    usage: { requests: 19, tokens: 980_000 },
  }, { now: 20, policy: POLICY });
  assert.equal(overload.state, seed.state);
  assert.deepEqual(overload.policy, seed.policy);
  assert.equal(overload.retryAt, 2020);
  assert.deepEqual(seed.state, stateSnapshot, "the reducer must never mutate persisted evidence");
  assert.ok(Object.isFrozen(seed.state) && Object.isFrozen(seed.state.tokens));
});

test("repeated opaque 429s add reversible pressure without guessing a rate dimension", () => {
  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: {
        "x-ratelimit-limit-requests": "40",
        "x-ratelimit-limit-tokens": "2000000",
      },
    }),
    usage: { requests: 1, tokens: 1000 },
  }, { now: 0, policy: POLICY });
  const opaque = at(100, 429, "resource_exhausted");
  const first = reduceProviderRateLearning(advertised.state, {
    outcome: "failure",
    signal: opaque,
    usage: { requests: 10, tokens: 500_000 },
  }, { now: 100, policy: POLICY });
  const second = reduceProviderRateLearning(first.state, {
    outcome: "failure",
    signal: at(2100, 429, "resource_exhausted"),
    usage: { requests: 11, tokens: 600_000 },
  }, { now: 2100, policy: POLICY });

  assert.deepEqual(second.policy, {
    windowMs: 60_000,
    requestsPerWindow: 32,
    tokensPerWindow: 980_000,
  });
  assert.deepEqual(second.state.pressure, {
    scale: 80,
    lower: 0,
    upper: 100,
    streak: 2,
    lastFailureAt: 2100,
    expiresAt: 1_802_100,
  });
  assert.equal(second.state.requests, advertised.state.requests);
  assert.equal(second.state.tokens, advertised.state.tokens);

  const lowTrafficSuccess = reduceProviderRateLearning(second.state, {
    outcome: "success",
    usage: { requests: 2, tokens: 100_000 },
    windowMs: 60_000,
  }, { now: 3000, policy: POLICY });
  assert.equal(lowTrafficSuccess.state.pressure.scale, 80);
  assert.equal(lowTrafficSuccess.state.pressure.streak, 0);
  assert.deepEqual(lowTrafficSuccess.policy, second.policy);

  const boundarySuccess = reduceProviderRateLearning(lowTrafficSuccess.state, {
    outcome: "success",
    usage: { requests: 29, tokens: 800_000 },
    windowMs: 60_000,
  }, { now: 4000, policy: POLICY });
  assert.equal(boundarySuccess.state.pressure.scale, 89);
  assert.equal(boundarySuccess.state.pressure.lower, 80);
  assert.equal(boundarySuccess.state.pressure.upper, 100);
  assert.deepEqual(boundarySuccess.policy, {
    windowMs: 60_000,
    requestsPerWindow: 35,
    tokensPerWindow: 980_000,
  });

  const expired = reduceProviderRateLearning(boundarySuccess.state, {
    outcome: "failure",
  }, { now: 1_802_101, policy: POLICY });
  assert.equal(expired.pressureExpired, true);
  assert.equal(expired.state.pressure, undefined);
  assert.deepEqual(expired.policy, advertised.policy);
});

test("explicit dimensionless rate codes use the same reversible pressure envelope", () => {
  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: {
        "x-ratelimit-limit-requests": "40",
        "x-ratelimit-limit-tokens": "2000000",
      },
    }),
  }, { now: 0, policy: POLICY });
  const firstSignal = parseProviderRateSignal({ status: 429, code: "Throttling.RateQuota", now: 100 });
  const first = reduceProviderRateLearning(advertised.state, {
    outcome: "failure",
    signal: firstSignal,
  }, { now: 100, policy: POLICY });
  const secondSignal = parseProviderRateSignal({ status: 429, code: "rate_limit_reached", now: 2_100 });
  const second = reduceProviderRateLearning(first.state, {
    outcome: "failure",
    signal: secondSignal,
  }, { now: 2_100, policy: POLICY });

  assert.deepEqual(
    [firstSignal.trusted, firstSignal.dimension, secondSignal.trusted, secondSignal.dimension],
    [true, "unknown", true, "unknown"],
  );
  assert.deepEqual(second.policy, {
    windowMs: 60_000,
    requestsPerWindow: 32,
    tokensPerWindow: 980_000,
  });
  assert.deepEqual(second.state.pressure, {
    scale: 80,
    lower: 0,
    upper: 100,
    streak: 2,
    lastFailureAt: 2_100,
    expiresAt: 1_802_100,
  });
  assert.equal(second.state.requests, advertised.state.requests);
  assert.equal(second.state.tokens, advertised.state.tokens);
});

test("sparse opaque 429s remain isolated incidents rather than congestion evidence", () => {
  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: { "x-ratelimit-limit-tokens": "2000000" },
    }),
  }, { now: 0, policy: POLICY });
  const first = reduceProviderRateLearning(advertised.state, {
    outcome: "failure",
    signal: at(100, 429, "resource_exhausted"),
  }, { now: 100, policy: POLICY });
  const later = reduceProviderRateLearning(first.state, {
    outcome: "failure",
    signal: at(60_101, 429, "resource_exhausted"),
  }, { now: 60_101, policy: POLICY });
  assert.equal(later.pressureExpired, true);
  assert.equal(later.state.pressure.scale, 100);
  assert.equal(later.state.pressure.streak, 1);
  assert.deepEqual(later.policy, advertised.policy);
});

test("opaque-only providers converge to a stable safe envelope instead of oscillating", () => {
  for (const actualTokens of [1_200_000, 1_500_000, 2_000_000, 3_000_000, 4_500_000]) {
    const simulation = simulateOpaqueCapacity(actualTokens);
    assert.ok(simulation.surfacedFailures <= 2, `${actualTokens}: too many exhausted retry budgets`);
    assert.ok(simulation.finalLimit <= actualTokens, `${actualTokens}: final policy must be safe`);
    assert.ok(simulation.finalLimit >= Math.max(POLICY.tokensPerWindow, actualTokens * 0.9), `${actualTokens}: convergence wastes capacity`);
    assert.equal(simulation.tailFailures, 0, `${actualTokens}: converged traffic must stop hitting opaque 429s`);
  }
});

test("opaque pressure never crosses the configured floor and an isolated failure clears on success", () => {
  let result = reduceProviderRateLearning(null, {
    outcome: "failure",
    signal: at(0, 429, "resource_exhausted"),
  }, { now: 0, policy: POLICY });
  result = reduceProviderRateLearning(result.state, {
    outcome: "success",
    usage: { requests: 1, tokens: 1000 },
    windowMs: 60_000,
  }, { now: 100, policy: POLICY });
  assert.equal(result.state, null, "one recovered opaque failure must leave no persisted pressure");

  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-limit-tokens": "5000000" },
    }),
  }, { now: 0, policy: POLICY });
  let state = advertised.state;
  for (let index = 1; index <= 100; index += 1) {
    const now = index * 100;
    const pressured = reduceProviderRateLearning(state, {
      outcome: "failure",
      signal: at(now, 429, "resource_exhausted"),
      usage: { requests: 100, tokens: 5_000_000 },
      windowMs: 60_000,
    }, { now, policy: POLICY });
    state = pressured.state;
    const effective = pressured.policy || POLICY;
    assert.ok(effective.requestsPerWindow >= POLICY.requestsPerWindow);
    assert.ok(effective.tokensPerWindow >= POLICY.tokensPerWindow);
  }
  assert.equal((reduceProviderRateLearning(state, { outcome: "failure" }, { now: 10_001, policy: POLICY }).policy || POLICY).requestsPerWindow, POLICY.requestsPerWindow);
  assert.equal((reduceProviderRateLearning(state, { outcome: "failure" }, { now: 10_001, policy: POLICY }).policy || POLICY).tokensPerWindow, POLICY.tokensPerWindow);
});

test("quota errors never become a TPM ceiling or a flow-control cooldown", () => {
  const signal = parseProviderRateSignal({
    status: 429,
    kind: "quota",
    code: "Throttling.AllocationQuota",
    now: 500,
    headers: { "retry-after": "60" },
  });
  const result = reduceProviderRateLearning(null, {
    outcome: "failure",
    signal,
    usage: { requests: 19, tokens: 980_000 },
  }, { now: 500, policy: POLICY });
  assert.equal(result.state, null);
  assert.equal(result.policy, null);
  assert.equal(result.retryAt, 0);
});

test("bounded probing converges upward and never learns below the configured floor", () => {
  const higher = simulateCapacity({ dimension: "tokens", actualLimit: 2_000_000, maxWindows: 20 });
  assert.ok(higher.errorRatio <= 0.02, `2M TPM should converge within 2%, got ${higher.limit}`);
  assert.ok(higher.windows <= 12, `2M TPM should converge within twelve observed windows, got ${higher.windows}`);
  assert.ok(higher.failures <= 4, `probing should bound failed windows, got ${higher.failures}`);

  const lower = simulateCapacity({ dimension: "tokens", actualLimit: 420_000, maxWindows: 30 });
  assert.equal(lower.limit, POLICY.tokensPerWindow);
  assert.equal(lower.target, POLICY.tokensPerWindow);

  const rpm = simulateCapacity({ dimension: "requests", actualLimit: 60, maxWindows: 30 });
  assert.ok(rpm.errorRatio <= 0.02, `60 RPM should converge within 2%, got ${rpm.limit}`);
  assert.ok(rpm.windows <= 20);

  const lowerRpm = simulateCapacity({ dimension: "requests", actualLimit: 8, maxWindows: 30 });
  assert.equal(lowerRpm.limit, POLICY.requestsPerWindow);
  assert.equal(lowerRpm.target, POLICY.requestsPerWindow);
});

test("capacity search converges across four orders of magnitude without invalid policies", () => {
  for (let index = 0; index < 1000; index += 1) {
    const tokenLimit = Math.max(1000, Math.floor(1000 * (10_000 ** (index / 999))));
    const learned = simulateCapacity({ dimension: "tokens", actualLimit: tokenLimit, maxWindows: 30 });
    assert.ok(
      Math.abs(learned.limit - learned.target) <= learned.target * 0.02,
      `failed to converge on ${tokenLimit} TPM: ${JSON.stringify(learned)}`,
    );
  }
  for (let requestLimit = 1; requestLimit <= 500; requestLimit += 1) {
    const learned = simulateCapacity({ dimension: "requests", actualLimit: requestLimit, maxWindows: 30 });
    assert.ok(
      Math.abs(learned.limit - learned.target) <= Math.max(1, learned.target * 0.02),
      `failed to converge on ${requestLimit} RPM: ${JSON.stringify(learned)}`,
    );
  }
});

test("trusted limits and failures below the floor remain visible instead of silently degrading throughput", () => {
  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: {
        "x-ratelimit-limit-requests": "8",
        "x-ratelimit-limit-tokens": "420000",
      },
    }),
    usage: { requests: 1, tokens: 1000 },
  }, { now: 0, policy: POLICY });
  assert.equal(advertised.policy, null, "an advertised limit below the configured floor must not throttle silently");

  const failed = reduceProviderRateLearning(null, {
    outcome: "failure",
    signal: parseProviderRateSignal({
      status: 429,
      code: "tokens_rate_limit_exceeded",
      now: 100,
    }),
    usage: { requests: 1, tokens: 800_000 },
  }, { now: 100, policy: POLICY });
  assert.equal(failed.policy, null);
  assert.equal(failed.state.tokens.upper, 800_000, "diagnostic evidence may be retained without lowering admission");
  assert.equal(failed.retryAt, 2_100, "the caller may perform one bounded recovery before surfacing repetition");
});

test("a later success disproves an old ceiling and stale evidence keeps its working-rate anchor", () => {
  const failureSignal = parseProviderRateSignal({
    status: 429,
    code: "tokens_rate_limit_exceeded",
    now: 0,
  });
  const failed = reduceProviderRateLearning(null, {
    outcome: "failure",
    signal: failureSignal,
    usage: { requests: 1, tokens: 1_200_000 },
  }, { now: 0, policy: POLICY });
  assert.equal(failed.policy, null);

  const disproved = reduceProviderRateLearning(failed.state, {
    outcome: "success",
    usage: { requests: 1, tokens: 1_250_000 },
  }, { now: 100, policy: POLICY });
  assert.equal(disproved.state.tokens.upper, 0);
  assert.equal(disproved.state.tokens.lower, 1_250_000);

  const expired = reduceProviderRateLearning(disproved.state, {
    outcome: "success",
    usage: { requests: 1, tokens: 1000 },
  }, { now: 6 * 60 * 60_000 + 101, policy: POLICY });
  assert.deepEqual(expired.staleDimensions, ["tokens"]);
  assert.deepEqual(expired.state.tokens, {
    lower: 0,
    upper: 0,
    exact: 0,
    anchor: 1_562_500,
    expiresAt: 0,
  });
  assert.equal(expired.policy.tokensPerWindow, 1_562_500);
  assert.equal(expired.changed, true);
});

test("stale ceilings stop blocking upward probes without resetting the adopted capacity", () => {
  const successful = reduceProviderRateLearning(null, {
    outcome: "success",
    usage: { requests: 1, tokens: 1_200_000 },
  }, { now: 0, policy: POLICY });
  const bounded = reduceProviderRateLearning(successful.state, {
    outcome: "failure",
    signal: parseProviderRateSignal({
      status: 429,
      code: "tokens_rate_limit_exceeded",
      now: 100,
    }),
    usage: { requests: 1, tokens: 1_800_000 },
    windowMs: POLICY.windowMs,
  }, { now: 100, policy: POLICY });
  const adopted = bounded.policy.tokensPerWindow;
  assert.ok(adopted > POLICY.tokensPerWindow && adopted < 1_800_000);

  const stale = reduceProviderRateLearning(bounded.state, {
    outcome: "failure",
  }, { now: 6 * 60 * 60_000 + 101, policy: POLICY });
  assert.equal(stale.policy.tokensPerWindow, adopted);
  assert.equal(stale.state.tokens.upper, 0);
  assert.equal(stale.state.tokens.anchor, adopted);

  const reprobed = reduceProviderRateLearning(stale.state, {
    outcome: "success",
    usage: { requests: 1, tokens: Math.ceil(adopted * 0.95) },
    windowMs: POLICY.windowMs,
  }, { now: 6 * 60 * 60_000 + 200, policy: POLICY });
  assert.ok(reprobed.policy.tokensPerWindow > adopted);
});

test("expired advertised request limits become warm-start anchors instead of permanent facts", () => {
  const advertised = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now: 0,
      headers: { "x-ratelimit-limit-requests": "40" },
    }),
    usage: { requests: 1, tokens: 1000 },
  }, { now: 0, policy: POLICY });
  assert.equal(advertised.state.requests.exact, 40);

  const stale = reduceProviderRateLearning(advertised.state, {
    outcome: "failure",
  }, { now: 24 * 60 * 60_000 + 1, policy: POLICY });
  assert.deepEqual(stale.staleDimensions, ["requests"]);
  assert.equal(stale.state.requests.exact, 0);
  assert.equal(stale.state.requests.anchor, 40);
  assert.equal(stale.policy.requestsPerWindow, 40);

  const corrected = reduceProviderRateLearning(stale.state, {
    outcome: "failure",
    signal: parseProviderRateSignal({
      status: 429,
      code: "requests_rate_limit_reached",
      now: 24 * 60 * 60_000 + 2,
    }),
    usage: { requests: 30, tokens: 1_000 },
    windowMs: POLICY.windowMs,
  }, { now: 24 * 60 * 60_000 + 2, policy: POLICY });
  assert.equal(corrected.policy, null, "a trusted lower ceiling may return the effective policy to its floor");
  assert.equal(corrected.state.requests.anchor, POLICY.requestsPerWindow);
  assert.equal(corrected.state.requests.upper, 30);
});

test("wrong-window, malformed, and randomized observations preserve finite invariants", () => {
  const wrongWindow = reduceProviderRateLearning(null, {
    outcome: "success",
    usage: { requests: 1000, tokens: 50_000_000 },
    windowMs: 1000,
  }, { now: 0, policy: POLICY });
  assert.equal(wrongWindow.state, null, "one-second usage must not be mistaken for RPM/TPM evidence");

  let state = null;
  const random = mulberry32(0x51a7e);
  for (let index = 0; index < 50_000; index += 1) {
    const status = [200, 400, 401, 429, 500, 503, 529, NaN][Math.floor(random() * 8)];
    const code = ["", "rate_limit_exceeded", "token_tpm_limit", "AllocationQuota", "???"][Math.floor(random() * 5)];
    const input = {
      status,
      code,
      now: index * 100,
      headers: random() < 0.05 ? {
        "x-ratelimit-limit-requests": randomValue(random),
        "x-ratelimit-limit-tokens": randomValue(random),
        "retry-after": randomValue(random),
      } : null,
    };
    const snapshot = structuredClone(input);
    const signal = parseProviderRateSignal(input);
    assert.deepEqual(input, snapshot, "signal parsing must not mutate its input");
    const result = reduceProviderRateLearning(state, {
      outcome: random() < 0.7 ? "success" : "failure",
      signal,
      usage: {
        requests: Math.floor(random() * 100),
        tokens: Math.floor(random() * 4_000_000),
      },
      windowMs: random() < 0.95 ? 60_000 : 1000,
    }, { now: index * 100, policy: POLICY });
    state = result.state;
    if (result.policy) {
      assert.ok(Number.isSafeInteger(result.policy.requestsPerWindow) && result.policy.requestsPerWindow > 0);
      assert.ok(Number.isSafeInteger(result.policy.tokensPerWindow) && result.policy.tokensPerWindow > 0);
      assert.ok(result.policy.requestsPerWindow >= POLICY.requestsPerWindow);
      assert.ok(result.policy.tokensPerWindow >= POLICY.tokensPerWindow);
    }
    assert.ok(Number.isSafeInteger(result.retryAt) && result.retryAt >= 0);
  }
});

function simulateCapacity({ dimension, actualLimit, maxWindows }) {
  const fallback = POLICY[dimension === "tokens" ? "tokensPerWindow" : "requestsPerWindow"];
  const target = Math.max(fallback, actualLimit);
  let state = null;
  let limit = fallback;
  let failures = 0;
  let stableWindows = 0;
  let window = 0;
  for (; window < maxWindows; window += 1) {
    const succeeded = limit <= actualLimit;
    if (!succeeded) failures += 1;
    const signal = succeeded
      ? parseProviderRateSignal({ status: 200, now: window * POLICY.windowMs })
      : parseProviderRateSignal({
        status: 429,
        code: dimension === "tokens" ? "tokens_rate_limit_exceeded" : "requests_rate_limit_exceeded",
        now: window * POLICY.windowMs,
      });
    const result = reduceProviderRateLearning(state, {
      outcome: succeeded ? "success" : "failure",
      signal,
      usage: {
        requests: dimension === "requests" ? limit : 1,
        tokens: dimension === "tokens" ? limit : 1000,
      },
      windowMs: POLICY.windowMs,
    }, { now: window * POLICY.windowMs, policy: POLICY });
    state = result.state;
    limit = result.policy?.[dimension === "tokens" ? "tokensPerWindow" : "requestsPerWindow"]
      ?? POLICY[dimension === "tokens" ? "tokensPerWindow" : "requestsPerWindow"];
    const closeEnough = Math.abs(limit - target) <= Math.max(1, target * 0.02);
    stableWindows = closeEnough ? stableWindows + 1 : 0;
    if (stableWindows >= 2) break;
  }
  return {
    limit,
    target,
    failures,
    windows: window + 1,
    errorRatio: Math.abs(limit - target) / target,
  };
}

function simulateOpaqueCapacity(actualTokens) {
  let now = 0;
  let learned = reduceProviderRateLearning(null, {
    outcome: "success",
    signal: parseProviderRateSignal({
      status: 200,
      now,
      headers: { "x-ratelimit-limit-tokens": "5000000" },
    }),
  }, { now, policy: POLICY });
  let state = learned.state;
  let surfacedFailures = 0;
  const outcomes = [];
  for (let request = 0; request < 40; request += 1) {
    now += 10_000;
    let failedAttempts = 0;
    let admitted = false;
    let limit = 0;
    while (failedAttempts < 3 && !admitted) {
      limit = (reduceProviderRateLearning(state, { outcome: "failure" }, { now, policy: POLICY }).policy || POLICY).tokensPerWindow;
      admitted = limit <= actualTokens;
      if (!admitted) {
        failedAttempts += 1;
        learned = reduceProviderRateLearning(state, {
          outcome: "failure",
          signal: at(now, 429, "resource_exhausted"),
          usage: { requests: 1, tokens: limit },
          windowMs: POLICY.windowMs,
        }, { now, policy: POLICY });
        state = learned.state;
        now += 2000;
      }
    }
    if (!admitted) surfacedFailures += 1;
    if (admitted && failedAttempts === 0) {
      learned = reduceProviderRateLearning(state, {
        outcome: "success",
        usage: { requests: 1, tokens: limit },
        windowMs: POLICY.windowMs,
      }, { now, policy: POLICY });
      state = learned.state;
    }
    outcomes.push({ admitted, limit });
  }
  return {
    surfacedFailures,
    finalLimit: outcomes.at(-1).limit,
    tailFailures: outcomes.slice(-10).filter(item => !item.admitted).length,
  };
}

function randomValue(random) {
  return ["", "0", "-1", "NaN", "1.5s", String(Math.floor(random() * 10_000_000))][Math.floor(random() * 6)];
}

function at(now, status, code) {
  return parseProviderRateSignal({ now, status, code });
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
