/** Provider-wide request admission using the existing request-token estimate. */

export interface RatePolicy { windowMs: number; requestsPerWindow: number; tokensPerWindow: number; burstToleranceMs: number; waitNoticeThresholdMs: number }
export type RatePolicyInput = Partial<Record<keyof RatePolicy, unknown>>;
export interface RateIdentity { sessionId: string; runId: string; spanId: string }
export interface RateReservation extends RateIdentity { id: string; key: string; estimatedTokens: number; startedAt: number }
export interface RateWaitEvent extends RateIdentity { key: string; waitedMs: number; waitMs: number; availableAt: number; estimatedTokens: number }
interface ReserveOptions extends Partial<RateIdentity> {
  key?: string; estimatedTokens?: number; policy?: RatePolicyInput | null;
  signal?: AbortSignal | null; onWait?: ((event: RateWaitEvent) => unknown) | null;
}
interface GovernorOptions extends RatePolicyInput {
  now?: () => number; wait?: (ms: number, signal: AbortSignal | null) => Promise<void>;
  onTrace?: ((event: Record<string, unknown>) => unknown) | null;
}
interface RateEntry {id: string; startedAt: number; tokens: number; estimatedTokens: number; settled: boolean}
interface BucketState { entries: RateEntry[]; requestVirtualAt: number | null; tokenVirtualAt: number | null; cooldownUntil: number; tail: Promise<void>; policy: RatePolicy }
interface StoredReservation { entry: RateEntry; state: BucketState; key: string; identity: RateIdentity; mode: 'observe' | 'enforce' }
interface AdmissionInput {state: BucketState; bucketKey: string; charge: number; queuedAt: number; signal: AbortSignal | null; onWait: ReserveOptions['onWait']; identity: RateIdentity}

export const DEFAULT_PROVIDER_RATE_POLICY = Object.freeze({
  windowMs: 60_000,
  requestsPerWindow: 19,
  tokensPerWindow: 980_000,
  burstToleranceMs: 6_000,
  waitNoticeThresholdMs: 5_000,
});

const ADMISSION_RECHECK_MAX_MS = 1_000;

export function createProviderRateGovernor(options: GovernorOptions = {}) {
  const policy = normalizePolicy(options);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const wait = typeof options.wait === "function" ? options.wait : waitWithAbort;
  const onTrace = typeof options.onTrace === "function" ? options.onTrace : null;
  const states = new Map<string, BucketState>();
  const reservations = new Map<string, StoredReservation>();
  let sequence = 0;

  async function reserve({
    key = "",
    estimatedTokens = 0,
    policy: policyOverride = null,
    signal = null,
    onWait = null,
    sessionId = "",
    runId = "",
    spanId = "",
  }: ReserveOptions = {}) {
    const bucketKey = String(key || "").trim();
    if (!bucketKey) throw new TypeError("provider rate key is required");
    throwIfAborted(signal);

    const state = getState(bucketKey);
    const identity = normalizeTraceIdentity({ sessionId, runId, spanId });
    const queuedAt = now();
    const task = state.tail
      .catch(() => undefined)
      .then(() => {
        applyStatePolicy(state, policyOverride);
        const charge = normalizeTokenCharge(estimatedTokens, state.policy.tokensPerWindow);
        return waitForAdmission({ state, bucketKey, charge, queuedAt, signal, onWait, identity });
      });
    state.tail = task.then(() => undefined, () => undefined);
    return raceWithAbort(task, signal);
  }

  function observe({
    key = "",
    estimatedTokens = 0,
    policy: policyOverride = null,
    sessionId = "",
    runId = "",
    spanId = "",
  }: ReserveOptions = {}) {
    const bucketKey = String(key || "").trim();
    if (!bucketKey) throw new TypeError("provider rate key is required");
    const state = getState(bucketKey);
    if (policyOverride) applyStatePolicy(state, policyOverride);
    const currentTime = now();
    pruneEntries(state, currentTime, state.policy.windowMs, reservations);
    return recordReservation({
      state,
      bucketKey,
      charge: normalizeObservedTokenCharge(estimatedTokens),
      currentTime,
      identity: normalizeTraceIdentity({ sessionId, runId, spanId }),
      mode: "observe",
    });
  }

  function settle(reservationId: unknown, reportedTokens: unknown) {
    const id = String(reservationId || "").trim();
    const reservation = reservations.get(id);
    if (!reservation || reservation.entry.settled) return false;
    const { entry, state, key, identity, mode } = reservation;
    entry.settled = true;
    if (mode !== "observe") {
      emitRateTrace("settled", state, key, identity, {
        estimatedTokens: entry.estimatedTokens,
        reportedTokens: normalizeReportedTokens(reportedTokens),
      });
    }
    return true;
  }

  function getUsage(key = "", { settledOnly = false, includeReservationId = "" } = {}) {
    const bucketKey = String(key || "").trim();
    const state = states.get(bucketKey);
    if (!state) return { requests: 0, tokens: 0, windowMs: policy.windowMs, policy };
    const currentTime = now();
    pruneEntries(state, currentTime, state.policy.windowMs, reservations);
    return {
      ...currentRateUsage(state, currentTime, state.policy.windowMs, { settledOnly, includeReservationId }),
      windowMs: state.policy.windowMs,
      policy: state.policy,
    };
  }

  function applyRetryAfter({
    key = "",
    retryAfterMs = 0,
    sessionId = "",
    runId = "",
    spanId = "",
  }: Partial<RateIdentity> & {key?: string; retryAfterMs?: number} = {}) {
    const bucketKey = String(key || "").trim();
    const delayMs = Math.max(0, Math.floor(Number(retryAfterMs) || 0));
    if (!bucketKey || delayMs <= 0) return false;
    const state = getState(bucketKey);
    const currentTime = now();
    const previousUntil = Number(state.cooldownUntil) || 0;
    state.cooldownUntil = Math.max(previousUntil, currentTime + delayMs);
    emitRateTrace("deferred", state, bucketKey, normalizeTraceIdentity({ sessionId, runId, spanId }), {
      retryAfterMs: delayMs,
      availableAt: state.cooldownUntil,
    });
    return state.cooldownUntil > previousUntil;
  }

  async function waitForAdmission({ state, bucketKey, charge, queuedAt, signal, onWait, identity }: AdmissionInput) {
    let noticeSent = false;
    let waitTraceSent = false;
    while (true) {
      throwIfAborted(signal);
      const currentTime = now();
      const activePolicy = state.policy;
      pruneEntries(state, currentTime, activePolicy.windowMs, reservations);
      const waitMs = admissionWaitMs(state, charge, currentTime, activePolicy);
      if (waitMs <= 0) {
        const reservation = recordReservation({
          state,
          bucketKey,
          charge,
          currentTime,
          identity,
          mode: "enforce",
        });
        emitRateTrace("admitted", state, bucketKey, identity, {
          estimatedTokens: charge,
          waitedMs: Math.max(0, currentTime - queuedAt),
        });
        return reservation;
      }

      const waitedMs = Math.max(0, currentTime - queuedAt);
      if (!waitTraceSent) {
        waitTraceSent = true;
        emitRateTrace("waiting", state, bucketKey, identity, { estimatedTokens: charge, waitedMs, waitMs });
      }
      const noticeDelayMs = noticeSent
        ? Number.POSITIVE_INFINITY
        : Math.max(0, activePolicy.waitNoticeThresholdMs - waitedMs);
      if (!noticeSent && noticeDelayMs <= 0) {
        noticeSent = true;
        callListener(onWait, {
          key: bucketKey,
          waitedMs,
          waitMs,
          availableAt: currentTime + waitMs,
          estimatedTokens: charge,
          ...identity,
        });
      }
      await wait(Math.max(1, Math.min(
        waitMs,
        noticeDelayMs > 0 ? noticeDelayMs : waitMs,
        ADMISSION_RECHECK_MAX_MS,
      )), signal);
    }
  }

  function recordReservation({ state, bucketKey, charge, currentTime, identity, mode }: Omit<AdmissionInput, "queuedAt" | "signal" | "onWait"> & {currentTime: number; mode: StoredReservation["mode"]}): RateReservation {
    const id = `rate_${(++sequence).toString(36)}_${Math.max(0, Math.floor(currentTime)).toString(36)}`;
    const entry = {
      id,
      startedAt: currentTime,
      tokens: charge,
      estimatedTokens: charge,
      settled: false,
    };
    state.entries.push(entry);
    advanceVirtualClocks(state, currentTime, charge, state.policy);
    reservations.set(id, { entry, state, key: bucketKey, identity, mode });
    return { id, key: bucketKey, estimatedTokens: charge, startedAt: currentTime, ...identity };
  }

  function getState(key: string) {
    let state = states.get(key);
    if (!state) {
      state = {
        entries: [],
        requestVirtualAt: null,
        tokenVirtualAt: null,
        cooldownUntil: 0,
        tail: Promise.resolve(),
        policy,
      };
      states.set(key, state);
    }
    return state;
  }

  function applyStatePolicy(state: BucketState, override: RatePolicyInput | null) {
    const next = normalizePolicy({ ...policy, ...(override || {}) });
    if (policiesEqual(state.policy, next)) return false;
    state.policy = next;
    rebuildVirtualClocks(state);
    return true;
  }

  function rebuildVirtualClocks(state: BucketState) {
    state.requestVirtualAt = null;
    state.tokenVirtualAt = null;
    for (const entry of state.entries) {
      advanceVirtualClocks(
        state,
        entry.startedAt,
        Math.min(entry.tokens, state.policy.tokensPerWindow),
        state.policy,
      );
    }
  }

  function emitRateTrace(phase: string, state: BucketState, key: string, identity: Partial<RateIdentity> = {}, fields: Record<string, unknown> = {}) {
    if (!onTrace) return;
    const activePolicy = state.policy;
    const usage = currentRateUsage(state, now(), activePolicy.windowMs);
    callListener(onTrace, {
      phase,
      provider: String(key || "").split("|", 1)[0],
      ...identity,
      rpm: usage.requests,
      rpmLimit: activePolicy.requestsPerWindow,
      tpm: usage.tokens,
      tpmLimit: activePolicy.tokensPerWindow,
      tokenUnit: "estimated",
      ...fields,
    });
  }

  return Object.freeze({
    reserve,
    observe,
    settle,
    getUsage,
    applyRetryAfter,
    policy,
  });
}

function normalizeTraceIdentity({ sessionId = "", runId = "", spanId = "" }: Partial<RateIdentity> = {}) {
  return {
    sessionId: String(sessionId || "").trim(),
    runId: String(runId || "").trim(),
    spanId: String(spanId || "").trim(),
  };
}

function currentRateUsage(state: BucketState, now: number, windowMs: number, { settledOnly = false, includeReservationId = "" } = {}) {
  let requests = 0;
  let tokens = 0;
  for (const entry of state?.entries || []) {
    if (entry.startedAt + windowMs <= now) continue;
    if (settledOnly && !entry.settled && entry.id !== includeReservationId) continue;
    requests += 1;
    tokens += entry.tokens;
  }
  return { requests, tokens };
}

function admissionWaitMs(state: BucketState, charge: number, now: number, policy: RatePolicy) {
  const requestCount = state.entries.length;
  const tokenTotal = state.entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const toleranceMs = headroomBurstToleranceMs({
    requestCount,
    tokenTotal,
    charge,
    policy,
  });
  let availableAt = Math.max(now, Number(state.cooldownUntil) || 0);
  if (state.requestVirtualAt !== null && Number.isFinite(state.requestVirtualAt)) {
    availableAt = Math.max(availableAt, state.requestVirtualAt - toleranceMs);
  }
  if (state.tokenVirtualAt !== null && Number.isFinite(state.tokenVirtualAt)) {
    availableAt = Math.max(availableAt, state.tokenVirtualAt - toleranceMs);
  }

  if (requestCount >= policy.requestsPerWindow) {
    const expiryIndex = requestCount - policy.requestsPerWindow;
    availableAt = Math.max(availableAt, state.entries[expiryIndex].startedAt + policy.windowMs);
  }

  let remainingTokenTotal = tokenTotal;
  if (remainingTokenTotal + charge > policy.tokensPerWindow) {
    for (const entry of state.entries) {
      remainingTokenTotal -= entry.tokens;
      availableAt = Math.max(availableAt, entry.startedAt + policy.windowMs);
      if (remainingTokenTotal + charge <= policy.tokensPerWindow) break;
    }
  }
  return Math.max(0, Math.ceil(availableAt - now));
}

function headroomBurstToleranceMs({ requestCount, tokenTotal, charge, policy }: {requestCount: number; tokenTotal: number; charge: number; policy: RatePolicy}) {
  // Express post-admission window headroom in the same time unit as both virtual clocks.
  // The exact rolling-window checks below remain the hard ceiling.
  const requestHeadroom = Math.max(0, policy.requestsPerWindow - requestCount - 1);
  const tokenHeadroom = Math.max(0, policy.tokensPerWindow - tokenTotal - charge);
  const requestSlackMs = requestHeadroom * policy.windowMs / policy.requestsPerWindow;
  const tokenSlackMs = tokenHeadroom * policy.windowMs / policy.tokensPerWindow;
  return Math.min(policy.burstToleranceMs, requestSlackMs, tokenSlackMs);
}

function advanceVirtualClocks(state: BucketState, startedAt: number, charge: number, policy: RatePolicy) {
  const requestBase = state.requestVirtualAt !== null && Number.isFinite(state.requestVirtualAt)
    ? Math.max(startedAt, state.requestVirtualAt)
    : startedAt;
  const tokenBase = state.tokenVirtualAt !== null && Number.isFinite(state.tokenVirtualAt)
    ? Math.max(startedAt, state.tokenVirtualAt)
    : startedAt;
  state.requestVirtualAt = requestBase + policy.windowMs / policy.requestsPerWindow;
  state.tokenVirtualAt = tokenBase + charge * policy.windowMs / policy.tokensPerWindow;
}

function pruneEntries(state: BucketState, now: number, windowMs: number, reservations: Map<string, StoredReservation>) {
  let removeCount = 0;
  while (removeCount < state.entries.length && state.entries[removeCount].startedAt + windowMs <= now) {
    reservations.delete(state.entries[removeCount].id);
    removeCount += 1;
  }
  if (removeCount > 0) state.entries.splice(0, removeCount);
  if (state.entries.length === 0) {
    state.requestVirtualAt = null;
    state.tokenVirtualAt = null;
  }
  if (Number(state.cooldownUntil) <= now) state.cooldownUntil = 0;
}

function normalizePolicy(options: RatePolicyInput = {}): RatePolicy {
  return Object.freeze({
    windowMs: positiveInteger(options.windowMs, DEFAULT_PROVIDER_RATE_POLICY.windowMs),
    requestsPerWindow: positiveInteger(options.requestsPerWindow, DEFAULT_PROVIDER_RATE_POLICY.requestsPerWindow),
    tokensPerWindow: positiveInteger(options.tokensPerWindow, DEFAULT_PROVIDER_RATE_POLICY.tokensPerWindow),
    burstToleranceMs: positiveInteger(options.burstToleranceMs, DEFAULT_PROVIDER_RATE_POLICY.burstToleranceMs),
    waitNoticeThresholdMs: nonNegativeInteger(options.waitNoticeThresholdMs, DEFAULT_PROVIDER_RATE_POLICY.waitNoticeThresholdMs),
  });
}

function normalizeTokenCharge(value: unknown, cap: number) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return 1;
  return Math.max(1, Math.min(cap, Math.ceil(tokens)));
}

function normalizeObservedTokenCharge(value: unknown) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return 1;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(tokens)));
}

function normalizeReportedTokens(value: unknown) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
}

function policiesEqual(left: RatePolicy, right: RatePolicy) {
  return left?.windowMs === right?.windowMs
    && left?.requestsPerWindow === right?.requestsPerWindow
    && left?.tokensPerWindow === right?.tokensPerWindow
    && left?.burstToleranceMs === right?.burstToleranceMs
    && left?.waitNoticeThresholdMs === right?.waitNoticeThresholdMs;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function callListener<T>(listener: ((event: T) => unknown) | null | undefined, event: T) {
  if (typeof listener !== "function") return;
  try {
    Promise.resolve(listener(event)).catch(() => undefined);
  } catch (_err) {}
}

function throwIfAborted(signal: AbortSignal | null) {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal | null) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Aborted", "AbortError");
}

function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function waitWithAbort(delayMs: number, signal: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
