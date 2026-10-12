import assert from "node:assert/strict";
import test from "node:test";

import { createProviderRateGovernor } from "../../src/background/llm/provider-rate-governor.js";

test("production policy always keeps adaptive burst headroom enabled", () => {
  const production = createProviderRateGovernor();
  const zeroOverride = createProviderRateGovernor({ burstToleranceMs: 0 });

  assert.equal(production.policy.burstToleranceMs, 6_000);
  assert.equal(zeroOverride.policy.burstToleranceMs, 6_000, "zero must not restore the removed strict-pacing algorithm");
});

test("provider governor paces requests and keeps providers independent", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "a", estimatedTokens: 10 });
  const otherProvider = await governor.reserve({ key: "b", estimatedTokens: 10 });
  const second = await governor.reserve({ key: "a", estimatedTokens: 10 });

  assert.equal(first.startedAt, 0);
  assert.equal(otherProvider.startedAt, 0, "another provider should not share the admission clock");
  assert.equal(second.startedAt, 500, "same-provider requests should respect RPM pacing");
});

test("headroom-aware tolerance allows a bounded burst and tightens near the RPM boundary", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 4,
    tokensPerWindow: 100_000,
    burstToleranceMs: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  const second = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  const third = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  const fourth = await governor.reserve({ key: "provider", estimatedTokens: 1 });

  assert.deepEqual(
    [first.startedAt, second.startedAt, third.startedAt, fourth.startedAt],
    [0, 0, 250, 750],
    "the remaining request headroom should progressively remove burst tolerance",
  );
});

test("headroom-aware tolerance becomes strict as the token window fills", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    burstToleranceMs: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 100 });
  const second = await governor.reserve({ key: "provider", estimatedTokens: 800 });
  const third = await governor.reserve({ key: "provider", estimatedTokens: 50 });

  assert.equal(first.startedAt, 0);
  assert.equal(second.startedAt, 0, "ample window headroom should absorb a short token burst");
  assert.equal(third.startedAt, 850, "only the remaining 50-token headroom may be borrowed near the limit");
});

test("provider governor keeps rolling token usage in its estimated unit after settlement", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 700 });
  assert.equal(governor.settle(first.id, 100), true);
  const second = await governor.reserve({ key: "provider", estimatedTokens: 400 });
  assert.equal(second.startedAt, 1000, "reported usage must not rewrite the virtual reservation");

  const third = await governor.reserve({ key: "provider", estimatedTokens: 700 });
  assert.equal(third.startedAt, 2000, "the rolling hard ceiling should wait until enough virtual usage has expired");
});

test("token cost advances the virtual clock after its own request", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const small = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  governor.settle(small.id, 1);
  const large = await governor.reserve({ key: "provider", estimatedTokens: 700 });
  const trailing = await governor.reserve({ key: "provider", estimatedTokens: 1 });

  assert.equal(large.startedAt, 0, "ample headroom should admit the large request without prepaying its interval");
  assert.equal(trailing.startedAt, 403, "the large request should reduce the burst allowance for the following admission");
});

test("reported usage cannot increase token debt for following requests", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 100 });
  governor.settle(first.id, 700);
  const second = await governor.reserve({ key: "provider", estimatedTokens: 1 });

  assert.equal(second.startedAt, 0, "reported usage must remain diagnostic instead of changing virtual debt");
});

test("model and tool time naturally absorbs virtual-clock debt", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 600 });
  governor.settle(first.id, 600);
  clock.advance(800);
  const second = await governor.reserve({ key: "provider", estimatedTokens: 1 });

  assert.equal(second.startedAt, 800);
});

test("an idle interval longer than the rolling window starts a fresh RPM and TPM window", async () => {
  const clock = fakeClock();
  const events = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 2,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => events.push(event),
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 700 });
  governor.settle(first.id, 600);
  clock.advance(5000);
  const second = await governor.reserve({ key: "provider", estimatedTokens: 400 });
  governor.settle(second.id, 300);

  assert.equal(second.startedAt, 5000, "expired requests and virtual-clock debt must not delay a new run");
  assert.deepEqual(
    events.slice(-2).map(event => [event.phase, event.rpm, event.tpm]),
    [["admitted", 1, 400], ["settled", 1, 400]],
    "the first request after a long idle should retain only its own virtual usage",
  );
  assert.equal(events.at(-1).reportedTokens, 300);
});

test("out-of-order settlements never adjust the shared virtual token clock", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const first = await governor.reserve({ key: "provider", estimatedTokens: 100 });
  const second = await governor.reserve({ key: "provider", estimatedTokens: 100 });
  governor.settle(second.id, 300);
  assert.equal(governor.settle(first.id, 200), true);
  assert.equal(governor.settle(first.id, 200), false);
  const third = await governor.reserve({ key: "provider", estimatedTokens: 1 });

  assert.equal(third.startedAt, 0, "settlement order and duplicate delivery must not distort virtual token debt");
});

test("provider governor traces rolling RPM and TPM at admission, wait, and settlement", async () => {
  const clock = fakeClock();
  const events = [];
  const identity = {
    sessionId: "child-session",
    runId: "child-run",
    spanId: "child-run:llm:1",
  };
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 1000,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => events.push(event),
  });

  const first = await governor.reserve({ key: "deepseek|openai|endpoint", estimatedTokens: 600, ...identity });
  governor.settle(first.id, 700);
  await governor.reserve({ key: "deepseek|openai|endpoint", estimatedTokens: 300, ...identity });

  assert.deepEqual(events.map(event => event.phase), ["admitted", "settled", "waiting", "admitted"]);
  assert.ok(events.every(event => (
    event.sessionId === identity.sessionId
    && event.runId === identity.runId
    && event.spanId === identity.spanId
  )), "every provider_rate phase should retain the request identity");
  assert.deepEqual(
    events.map(event => [event.provider, event.rpm, event.tpm, event.rpmLimit, event.tpmLimit]),
    [
      ["deepseek", 1, 600, 1000, 1000],
      ["deepseek", 1, 600, 1000, 1000],
      ["deepseek", 1, 600, 1000, 1000],
      ["deepseek", 2, 900, 1000, 1000],
    ],
  );
  assert.equal(events[1].reportedTokens, 700);
});

test("Retry-After defers every later session on the same provider only", async () => {
  const clock = fakeClock();
  const events = [];
  const governor = createProviderRateGovernor({
    windowMs: 10_000,
    requestsPerWindow: 100,
    tokensPerWindow: 100_000,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => events.push(event),
  });

  assert.equal(governor.applyRetryAfter({
    key: "deepseek|openai|endpoint",
    retryAfterMs: 5000,
    sessionId: "session-a",
    runId: "run-a",
    spanId: "run-a:llm:1",
  }), true);
  const independent = await governor.reserve({ key: "bailian|openai|endpoint", estimatedTokens: 10 });
  const shared = await governor.reserve({
    key: "deepseek|openai|endpoint",
    estimatedTokens: 10,
    sessionId: "session-b",
    runId: "run-b",
    spanId: "run-b:llm:1",
  });

  assert.equal(independent.startedAt, 0);
  assert.equal(shared.startedAt, 5000);
  const deferred = events.find(event => event.phase === "deferred");
  assert.deepEqual(
    [deferred?.sessionId, deferred?.runId, deferred?.spanId, deferred?.retryAfterMs, deferred?.availableAt],
    ["session-a", "run-a", "run-a:llm:1", 5000, 5000],
  );
  const waiting = events.find(event => event.phase === "waiting" && event.sessionId === "session-b");
  assert.equal(waiting?.waitMs, 5000);
});

test("Retry-After may extend but never shorten an active provider cooldown", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 10_000,
    requestsPerWindow: 100,
    tokensPerWindow: 100_000,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(governor.applyRetryAfter({ key: "provider", retryAfterMs: 5000 }), true);
  clock.advance(1000);
  assert.equal(governor.applyRetryAfter({ key: "provider", retryAfterMs: 2000 }), false);
  assert.equal(governor.applyRetryAfter({ key: "provider", retryAfterMs: 7000 }), true);
  const admitted = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  assert.equal(admitted.startedAt, 8000);
});

test("aborting during a provider cooldown does not consume window capacity", async () => {
  let time = 0;
  let releaseWait = null;
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: () => time,
    wait: ms => new Promise(resolve => {
      releaseWait = () => {
        time += ms;
        resolve();
      };
    }),
  });
  governor.applyRetryAfter({ key: "provider", retryAfterMs: 1000 });
  const controller = new AbortController();
  const pending = governor.reserve({ key: "provider", estimatedTokens: 1, signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, error => error?.name === "AbortError");

  releaseWait?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  const admitted = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  assert.equal(admitted.startedAt, 1000);
});

test("an oversized request drains one window instead of waiting forever", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    now: clock.now,
    wait: clock.wait,
  });

  const oversized = await governor.reserve({ key: "provider", estimatedTokens: 5000 });
  const trailing = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  assert.equal(oversized.estimatedTokens, 1000);
  assert.equal(trailing.startedAt, 1000);
});

test("wait feedback is emitted once only after five seconds have elapsed", async () => {
  const clock = fakeClock();
  const governor = createProviderRateGovernor({
    windowMs: 10_000,
    requestsPerWindow: 1,
    tokensPerWindow: 1000,
    waitNoticeThresholdMs: 5000,
    now: clock.now,
    wait: clock.wait,
  });
  const notices = [];

  await governor.reserve({ key: "provider", estimatedTokens: 1 });
  const second = await governor.reserve({
    key: "provider",
    estimatedTokens: 1,
    sessionId: "session-waiting",
    runId: "run-waiting",
    spanId: "run-waiting:llm:2",
    onWait: event => notices.push(event),
  });

  assert.equal(second.startedAt, 10_000);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].waitedMs, 5000);
  assert.equal(notices[0].waitMs, 5000);
  assert.equal(notices[0].sessionId, "session-waiting");
  assert.equal(notices[0].runId, "run-waiting");
  assert.equal(notices[0].spanId, "run-waiting:llm:2");

  const quietClock = fakeClock();
  const quietGovernor = createProviderRateGovernor({
    windowMs: 4000,
    requestsPerWindow: 1,
    tokensPerWindow: 1000,
    waitNoticeThresholdMs: 5000,
    now: quietClock.now,
    wait: quietClock.wait,
  });
  await quietGovernor.reserve({ key: "provider", estimatedTokens: 1 });
  await quietGovernor.reserve({ key: "provider", estimatedTokens: 1, onWait: event => notices.push(event) });
  assert.equal(notices.length, 1, "sub-five-second waits should stay silent");

  const thresholdClock = fakeClock();
  const thresholdGovernor = createProviderRateGovernor({
    windowMs: 5000,
    requestsPerWindow: 1,
    tokensPerWindow: 1000,
    waitNoticeThresholdMs: 5000,
    now: thresholdClock.now,
    wait: thresholdClock.wait,
  });
  await thresholdGovernor.reserve({ key: "provider", estimatedTokens: 1 });
  await thresholdGovernor.reserve({ key: "provider", estimatedTokens: 1, onWait: event => notices.push(event) });
  assert.equal(notices.length, 1, "a wait ending exactly at the threshold should stay silent");
});

test("settlement never releases a queued virtual estimate", async () => {
  let time = 0;
  let firstReservation = null;
  let governor = null;
  let settled = false;
  const wait = async ms => {
    if (!settled) {
      time += Math.min(ms, 200);
      governor.settle(firstReservation.id, 100);
      settled = true;
      return;
    }
    time += ms;
  };
  governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 1000,
    tokensPerWindow: 1000,
    now: () => time,
    wait,
  });

  firstReservation = await governor.reserve({ key: "provider", estimatedTokens: 900 });
  const second = await governor.reserve({ key: "provider", estimatedTokens: 500 });

  assert.equal(second.startedAt, 1000, "reported usage must not release the original virtual-time reservation");
});

test("an aborted queued reservation is rejected without consuming capacity", async () => {
  let time = 0;
  let releaseWait = null;
  const wait = ms => new Promise(resolve => {
    releaseWait = () => {
      time += ms;
      resolve();
    };
  });
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 1,
    tokensPerWindow: 1000,
    now: () => time,
    wait,
  });
  await governor.reserve({ key: "provider", estimatedTokens: 1 });

  const controller = new AbortController();
  const queued = governor.reserve({ key: "provider", estimatedTokens: 1, signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(queued, error => error?.name === "AbortError");

  releaseWait?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  const next = await governor.reserve({ key: "provider", estimatedTokens: 1 });
  assert.equal(next.startedAt, 1000, "the aborted request must not consume capacity after the first request expires");
});

test("passive observation records virtual usage without waiting or emitting governor traces", () => {
  const events = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 1,
    tokensPerWindow: 100,
    onTrace: event => events.push(event),
  });
  const first = governor.observe({ key: "provider", estimatedTokens: 300 });
  const second = governor.observe({ key: "provider", estimatedTokens: 400 });
  assert.equal(governor.settle(first.id, 350), true);
  assert.equal(governor.settle(second.id, 450), true);

  const usage = governor.getUsage("provider");
  assert.deepEqual([usage.requests, usage.tokens], [2, 700]);
  assert.equal(events.length, 0, "an off switch must remain invisible to user-facing rate traces");
});

test("capacity evidence can exclude failed attempts without changing admission debt", () => {
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 10,
    tokensPerWindow: 1000,
  });
  const failed = governor.observe({ key: "provider", estimatedTokens: 300 });
  const completed = governor.observe({ key: "provider", estimatedTokens: 400 });
  governor.settle(completed.id);

  assert.deepEqual(
    usagePair(governor.getUsage("provider")),
    [2, 700],
    "all attempts must still consume the rolling admission window",
  );
  assert.deepEqual(
    usagePair(governor.getUsage("provider", { settledOnly: true })),
    [1, 400],
    "successful capacity probes must exclude failed attempts",
  );
  assert.deepEqual(
    usagePair(governor.getUsage("provider", {
      settledOnly: true,
      includeReservationId: failed.id,
    })),
    [2, 700],
    "a failing probe must include itself when recording its upper bound",
  );
});

test("passive observation preserves an already learned policy", async () => {
  const governor = createProviderRateGovernor({
    windowMs: 60_000,
    requestsPerWindow: 19,
    tokensPerWindow: 980_000,
  });
  await governor.reserve({
    key: "provider",
    estimatedTokens: 100,
    policy: { requestsPerWindow: 40, tokensPerWindow: 2_000_000 },
  });

  governor.observe({ key: "provider", estimatedTokens: 100 });

  assert.equal(governor.getUsage("provider").policy.requestsPerWindow, 40);
  assert.equal(governor.getUsage("provider").policy.tokensPerWindow, 2_000_000);
});

test("a learned policy rebases existing virtual clocks without replacing the governor", async () => {
  const clock = fakeClock();
  const events = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 1,
    tokensPerWindow: 1000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => events.push(event),
  });

  await governor.reserve({ key: "provider", estimatedTokens: 1 });
  const second = await governor.reserve({
    key: "provider",
    estimatedTokens: 1,
    policy: { requestsPerWindow: 2, tokensPerWindow: 2000 },
  });

  assert.equal(second.startedAt, 500, "the learned capacity should affect the next admission immediately");
  assert.equal(governor.getUsage("provider").policy.requestsPerWindow, 2);
  assert.equal(events.at(-1).rpmLimit, 2);
  assert.equal(events.at(-1).tpmLimit, 2000);
});

test("concurrent policy changes are serialized with their reservation", async () => {
  const clock = fakeClock();
  const events = [];
  const governor = createProviderRateGovernor({
    windowMs: 1000,
    requestsPerWindow: 100,
    tokensPerWindow: 2000,
    burstToleranceMs: 1,
    now: clock.now,
    wait: clock.wait,
    onTrace: event => events.push(event),
  });

  const first = governor.reserve({
    key: "provider",
    estimatedTokens: 1500,
    policy: { requestsPerWindow: 100, tokensPerWindow: 2000 },
  });
  const second = governor.reserve({
    key: "provider",
    estimatedTokens: 1,
    policy: { requestsPerWindow: 100, tokensPerWindow: 1000 },
  });
  const [firstReservation, secondReservation] = await Promise.all([first, second]);

  assert.equal(firstReservation.estimatedTokens, 1500);
  assert.equal(secondReservation.startedAt, 1000);
  assert.deepEqual(
    events.filter(event => event.phase === "admitted").map(event => [event.tpm, event.tpmLimit]),
    [[1500, 2000], [1, 1000]],
    "a queued policy update must not change the policy used by an earlier reservation",
  );
});

function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    advance: ms => { time += ms; },
    wait: async (ms, signal) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      time += ms;
    },
  };
}

function usagePair(usage) {
  return [usage.requests, usage.tokens];
}
