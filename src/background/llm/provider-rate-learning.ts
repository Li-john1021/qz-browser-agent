/** Pure provider-rate signal normalization and capacity learning. */

import {
  capLlmProviderBackoffMs,
  retryAfterMsFromHeaders,
} from "./provider-errors.js";

import type { RatePolicy, RatePolicyInput } from './provider-rate-governor.js';
import type { HeaderReader } from './provider-errors.js';
export type RateDimension = 'requests' | 'tokens';
export type CapacityPolicy = Pick<RatePolicy, 'windowMs' | 'requestsPerWindow' | 'tokensPerWindow'>;
export interface DimensionEvidence { lower: number; upper: number; exact: number; anchor: number; expiresAt: number }
export interface PressureEvidence {scale: number; lower: number; upper: number; streak: number; lastFailureAt: number; expiresAt: number}
export interface LearningState {version: 1; requests: DimensionEvidence | null; tokens: DimensionEvidence | null; pressure?: PressureEvidence}
interface RateLimit {limit: number; remaining: number | null; resetAt: number}
type RateLimits = Partial<Record<RateDimension, RateLimit>> | null;
export interface RateSignal {type: 'none' | 'quota' | 'overload' | 'rate_limit' | 'limits'; dimension: RateDimension | 'unknown'; trusted: boolean; retryAt: number; limits: RateLimits}
export interface SignalInput {now?: number; headers?: HeaderReader | Record<string, unknown> | null; status?: unknown; code?: unknown; kind?: unknown; retryAfterMs?: unknown}
export interface LearningResult {state: LearningState | null; policy: CapacityPolicy | null; retryAt: number; changed: boolean; staleDimensions?: readonly RateDimension[]; pressureExpired?: boolean}
export interface RateUsage {requests: number; tokens: number}
interface LearningEvent {now?: number; signal?: RateSignal | null; outcome?: string; usage?: Partial<RateUsage> | null; windowMs?: number}
const DIMENSIONS: readonly RateDimension[] = ['requests', 'tokens'];

const MINUTE_MS = 60_000;
const LEARNED_TTL_MS = 6 * 60 * MINUTE_MS;
const EXPLICIT_TTL_MS = 24 * 60 * MINUTE_MS;
const GROWTH_FACTOR = 1.25;
const PROBE_THRESHOLD = 0.9;
const CONVERGED_RATIO = 1.02;
const FALLBACK_BACKOFF_MS = 2_000;
const PRESSURE_REPEAT_MS = MINUTE_MS;
const PRESSURE_TTL_MS = 30 * MINUTE_MS;
const PRESSURE_DOWN_PERCENT = 80;

const NO_SIGNAL: Readonly<RateSignal> = Object.freeze({
  type: "none",
  dimension: "unknown",
  trusted: false,
  retryAt: 0,
  limits: null,
});
const NO_RESULT: Readonly<LearningResult> = Object.freeze({
  state: null,
  policy: null,
  retryAt: 0,
  changed: false,
});

const RATE_HEADERS = Object.freeze({
  requests: Object.freeze({
    limit: ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"],
    remaining: ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"],
    reset: ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"],
  }),
  tokens: Object.freeze({
    limit: ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"],
    remaining: ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"],
    reset: ["x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"],
  }),
});

/** Translate headers and normalized provider error facts without interpreting prose. */
export function parseProviderRateSignal(input: SignalInput = {}): RateSignal {
  const now = nonNegativeInteger(input.now, 0);
  const readHeader = createHeaderReader(input.headers);
  const limits = readRateLimits(readHeader, now);
  const status = positiveInteger(input.status, 0);
  const codeKey = String(input.code || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const quota = /allocationquota|insufficientquota|quota(?:exceeded|exhausted)|usagelimit|billing|outofbudget/.test(codeKey);
  const explicitRate = /ratelimit|ratequota|toomanyrequests|throttl|tpm|rpm|tokens?perminute|requests?perminute/.test(codeKey) && !quota;
  const overload = /overload|serverbusy|serviceunavailable|temporarilyunavailable/.test(codeKey);
  const nonRate = /context(?:length|window)|maximumcontext|prompt(?:toolong|length)|input(?:toolarge|length)|toomanytokens|authentication|unauthorized|invalidapikey|permissiondenied|accessdenied|forbidden|contentfilter|contentpolicy|safetypolicy|moderation|blockedcontent|invalidrequest|badrequest|unprocessable/.test(codeKey);
  const dimension = rateDimension(codeKey, limits);
  const explicitDelay = nonNegativeNumber(input.retryAfterMs, null)
    ?? retryAfterMsFromHeaders(toHeaders(input.headers), now);
  const retryAt = (explicitDelay == null ? 0 : safeAdd(now, explicitDelay))
    || exhaustedResetAt(limits, dimension);

  if (quota) return makeSignal("quota", { retryAt, limits });
  if (explicitRate) {
    return makeSignal("rate_limit", {
      dimension,
      trusted: true,
      retryAt,
      limits,
    });
  }
  if (overload) {
    return makeSignal("overload", { retryAt, limits: null });
  }
  if (nonRate) return NO_SIGNAL;
  if (status === 429) {
    return makeSignal("rate_limit", {
      dimension,
      trusted: hasAdvertisedLimit(limits),
      retryAt,
      limits,
    });
  }
  if (status === 503 || status === 529 || status >= 500) return makeSignal("overload", { retryAt, limits: null });
  if (hasRateFacts(limits) && status < 400) {
    return makeSignal("limits", { trusted: true, limits });
  }
  return NO_SIGNAL;
}

/**
 * Evolve provider capacity evidence. The caller owns persistence and supplies the
 * rolling-window usage and fallback policy; this function performs no I/O and
 * reads no clock.
 */
export function reduceProviderRateLearning(state: unknown, event: LearningEvent = {}, options: {now?: number; policy?: RatePolicyInput} = {}): Readonly<LearningResult> {
  const now = nonNegativeInteger(options.now ?? event.now, 0);
  const fallback = normalizePolicy(options.policy);
  const signal = normalizeSignal(event.signal);
  const outcome = event.outcome === "success" ? "success" : "failure";
  const usage = {
    requests: positiveInteger(event.usage?.requests, 0),
    tokens: positiveInteger(event.usage?.tokens, 0),
  };
  const usageWindowMs = positiveInteger(event.windowMs, fallback.windowMs);
  const normalized = state ? normalizeState(state, now, fallback) : null;
  const activeState = normalized?.state || null;
  const staleDimensions = normalized?.staleDimensions || null;
  const pressureExpired = normalized?.pressureExpired === true;

  if (!state && !activeState && signal === NO_SIGNAL && (
    outcome !== "success"
    || usageWindowMs !== fallback.windowMs
    || (usage.requests < fallback.requestsPerWindow * PROBE_THRESHOLD
      && usage.tokens < fallback.tokensPerWindow * PROBE_THRESHOLD)
  )) {
    return NO_RESULT;
  }

  let requests = activeState?.requests || null;
  let tokens = activeState?.tokens || null;
  let pressure = activeState?.pressure || null;
  if (signal.type === "limits" || signal.type === "rate_limit") {
    requests = recordAdvertisedLimit(requests, signal.limits?.requests?.limit, now);
  }

  if (usageWindowMs === fallback.windowMs && outcome === "success") {
    requests = recordSuccess(requests, usage.requests, resolvedLimit(requests, fallback.requestsPerWindow), now);
    tokens = recordSuccess(tokens, usage.tokens, resolvedLimit(tokens, fallback.tokensPerWindow), now);
  } else if (usageWindowMs === fallback.windowMs && signal.type === "rate_limit" && signal.trusted) {
    if (signal.dimension === "requests" && !requests?.exact) {
      requests = recordFailure(requests, usage.requests, now);
    } else if (signal.dimension === "tokens" && !tokens?.exact) {
      tokens = recordFailure(tokens, usage.tokens, now);
    }
  }

  requests = withResolvedAnchor(requests, fallback.requestsPerWindow);
  tokens = withResolvedAnchor(tokens, fallback.tokensPerWindow);
  if (isDimensionlessRateLimit(signal)) {
    pressure = recordScalarPressureFailure(pressure, now);
  } else if (outcome === "success" && usageWindowMs === fallback.windowMs) {
    pressure = recordPressureSuccess(pressure, usage, requests, tokens, fallback);
  }

  const nextState = makeState(activeState, requests, tokens, pressure);
  const policy = resolvedPolicy(nextState, fallback);
  const shouldBackoff = signal.type === "rate_limit" || signal.type === "overload";
  const signalDelayMs = Math.max(0, nonNegativeInteger(signal.retryAt, 0) - now);
  const retryDelayMs = shouldBackoff
    ? capLlmProviderBackoffMs(Math.max(FALLBACK_BACKOFF_MS, signalDelayMs))
    : null;
  const retryAt = retryDelayMs == null ? 0 : safeAdd(now, retryDelayMs);
  const result: LearningResult = {
    state: nextState,
    policy,
    retryAt,
    changed: nextState !== state,
  };
  if (staleDimensions?.length) result.staleDimensions = staleDimensions;
  if (pressureExpired) result.pressureExpired = true;
  return Object.freeze(result);
}

function recordAdvertisedLimit(current: DimensionEvidence | null, value: unknown, now: number) {
  const exact = positiveInteger(value, 0);
  if (!exact) return current;
  if (current?.exact === exact && current.expiresAt > now + EXPLICIT_TTL_MS / 2) return current;
  return Object.freeze({ lower: 0, upper: 0, exact, anchor: exact, expiresAt: now + EXPLICIT_TTL_MS });
}

function recordSuccess(current: DimensionEvidence | null, observed: number, target: number, now: number) {
  if (!observed || current?.exact || observed < target * PROBE_THRESHOLD) return current;
  const lower = Math.max(current?.lower || 0, observed);
  const upper = current?.upper && lower < current.upper ? current.upper : 0;
  if (current && current.lower === lower && current.upper === upper) return current;
  return Object.freeze({
    lower,
    upper,
    exact: 0,
    anchor: current?.anchor || 0,
    expiresAt: now + LEARNED_TTL_MS,
  });
}

function recordFailure(current: DimensionEvidence | null, observed: number, now: number) {
  if (!observed) return current;
  const upper = current?.upper ? Math.min(current.upper, observed) : observed;
  const lower = current?.lower && current.lower < upper ? current.lower : 0;
  if (current && current.lower === lower && current.upper === upper) return current;
  return Object.freeze({
    lower,
    upper,
    exact: 0,
    anchor: current?.anchor || 0,
    expiresAt: now + LEARNED_TTL_MS,
  });
}

function recordScalarPressureFailure(current: PressureEvidence | null, now: number) {
  const repeated = current && safeAdd(current.lastFailureAt, PRESSURE_REPEAT_MS) >= now;
  const shouldTighten = (current?.scale ?? 100) < 100 || repeated;
  const upper = shouldTighten ? Math.min(current?.upper || 100, current?.scale || 100) : 0;
  const lower = current?.lower && current.lower < upper ? current.lower : 0;
  const scale = shouldTighten ? nextPressureProbe(lower, upper, current?.scale || 100) : 100;
  return Object.freeze({
    scale,
    lower,
    upper,
    streak: repeated ? Math.min(Number.MAX_SAFE_INTEGER, current.streak + 1) : 1,
    lastFailureAt: now,
    expiresAt: safeAdd(now, scale < 100 ? PRESSURE_TTL_MS : PRESSURE_REPEAT_MS),
  });
}

function recordPressureSuccess(current: PressureEvidence | null, usage: RateUsage, requests: DimensionEvidence | null, tokens: DimensionEvidence | null, fallback: CapacityPolicy) {
  if (!current) return null;
  if (current.scale >= 100) return null;
  const requestLimit = applyPressure(resolvedLimit(requests, fallback.requestsPerWindow), current.scale, fallback.requestsPerWindow);
  const tokenLimit = applyPressure(resolvedLimit(tokens, fallback.tokensPerWindow), current.scale, fallback.tokensPerWindow);
  const provedBoundary = usage.requests >= requestLimit * PROBE_THRESHOLD
    || usage.tokens >= tokenLimit * PROBE_THRESHOLD;
  if (!provedBoundary) {
    if (!current.streak) return current;
    return Object.freeze({ ...current, streak: 0 });
  }
  const lower = Math.max(current.lower || 0, current.scale);
  const upper = current.upper && lower < current.upper ? current.upper : 0;
  const scale = upper
    ? nextPressureProbe(lower, upper, current.scale)
    : Math.min(100, Math.ceil(current.scale * 1.05));
  if (scale >= 100) return null;
  if (!current.streak && scale === current.scale && lower === current.lower && upper === current.upper) return current;
  return Object.freeze({ ...current, scale, lower, upper, streak: 0 });
}

function nextPressureProbe(lower: number, upper: number, current: number) {
  if (!lower) return Math.max(1, Math.floor(current * PRESSURE_DOWN_PERCENT / 100));
  if (upper <= lower + 1) return lower;
  return Math.min(upper - 1, Math.max(lower + 1, Math.floor(Math.sqrt(lower * upper))));
}

function resolvedPolicy(state: LearningState | null, fallback: CapacityPolicy) {
  const scale = state?.pressure?.scale || 100;
  const requestsPerWindow = applyPressure(
    resolvedLimit(state?.requests, fallback.requestsPerWindow),
    scale,
    fallback.requestsPerWindow,
  );
  const tokensPerWindow = applyPressure(
    resolvedLimit(state?.tokens, fallback.tokensPerWindow),
    scale,
    fallback.tokensPerWindow,
  );
  if (requestsPerWindow === fallback.requestsPerWindow && tokensPerWindow === fallback.tokensPerWindow) return null;
  return Object.freeze({ windowMs: fallback.windowMs, requestsPerWindow, tokensPerWindow });
}

function applyPressure(limit: number, scale: number, floor: number) {
  return Math.max(floor, Math.floor(limit * scale / 100));
}

function resolvedLimit(dimension: Partial<DimensionEvidence> | null | undefined, fallback: number): number {
  if (!dimension) return fallback;
  if (dimension.exact) return Math.max(fallback, dimension.exact);
  let candidate = fallback;
  if (dimension.lower && dimension.upper) {
    if (dimension.upper / dimension.lower <= CONVERGED_RATIO || dimension.upper <= dimension.lower + 1) {
      candidate = dimension.lower;
    } else {
      const midpoint = Math.floor(dimension.lower * Math.sqrt(dimension.upper / dimension.lower));
      candidate = Math.min(dimension.upper - 1, Math.max(dimension.lower + 1, midpoint));
    }
  } else if (dimension.upper) {
    candidate = Math.floor(dimension.upper / 2);
  } else if (dimension.lower) {
    candidate = Math.ceil(dimension.lower * GROWTH_FACTOR);
  } else if (dimension.anchor) {
    candidate = dimension.anchor;
  }
  return Math.max(fallback, candidate);
}

function normalizeState(value: unknown, now: number, fallback: CapacityPolicy): {state: LearningState | null; staleDimensions: readonly RateDimension[] | null; pressureExpired: boolean} {
  if (!value || typeof value !== "object") return { state: null, staleDimensions: null, pressureExpired: false };
  const state = value as Record<string, unknown>;
  const requests = normalizeDimension(state.requests, now, fallback.requestsPerWindow);
  const tokens = normalizeDimension(state.tokens, now, fallback.tokensPerWindow);
  const pressure = normalizePressure(state.pressure, now);
  const staleDimensions: RateDimension[] = [];
  if (requests.stale) staleDimensions.push("requests");
  if (tokens.stale) staleDimensions.push("tokens");
  let normalizedState: LearningState | null = null;
  if (requests.value || tokens.value || pressure.value) {
    normalizedState = state.version === 1
      && requests.value === state.requests
      && tokens.value === state.tokens
      && pressure.value === (state.pressure ?? null)
      ? state as unknown as LearningState
      : makeState(null, requests.value, tokens.value, pressure.value);
  }
  return {
    state: normalizedState,
    staleDimensions: staleDimensions.length ? Object.freeze(staleDimensions) : null,
    pressureExpired: pressure.expired,
  };
}

function normalizePressure(input: unknown, now: number): {value: PressureEvidence | null; expired: boolean} {
  if (!input || typeof input !== "object") return { value: null, expired: false };
  const value = input as Record<string, unknown>;
  const scale = Math.max(1, Math.min(100, positiveInteger(value.scale, 100)));
  let lower = Math.min(100, nonNegativeInteger(value.lower, 0));
  const upper = Math.min(100, nonNegativeInteger(value.upper, 0));
  if (upper && lower >= upper) lower = 0;
  const streak = nonNegativeInteger(value.streak, 0);
  const lastFailureAt = nonNegativeInteger(value.lastFailureAt, 0);
  const expiresAt = positiveInteger(value.expiresAt, 0);
  if (!expiresAt || expiresAt <= now || (scale >= 100 && !streak)) {
    return { value: null, expired: Boolean(expiresAt && expiresAt <= now) };
  }
  if (value.scale === scale && value.lower === lower && value.upper === upper && value.streak === streak
    && value.lastFailureAt === lastFailureAt && value.expiresAt === expiresAt) {
    return { value: value as unknown as PressureEvidence, expired: false };
  }
  return {
    value: Object.freeze({ scale, lower, upper, streak, lastFailureAt, expiresAt }),
    expired: false,
  };
}

function normalizeDimension(input: unknown, now: number, fallback: number): {value: DimensionEvidence | null; stale: boolean} {
  if (!input || typeof input !== "object") return { value: null, stale: false };
  const value = input as Record<string, unknown>;
  const expiresAt = positiveInteger(value.expiresAt, 0);
  const exact = positiveInteger(value.exact, 0);
  let lower = exact ? 0 : positiveInteger(value.lower, 0);
  const upper = exact ? 0 : positiveInteger(value.upper, 0);
  if (upper && lower >= upper) lower = 0;
  const hasEvidence = Boolean(exact || lower || upper);
  const learnedAnchor = hasEvidence
    ? resolvedLimit({ lower, upper, exact }, fallback)
    : Math.max(fallback, positiveInteger(value.anchor, 0));

  if (!hasEvidence) {
    if (learnedAnchor <= fallback) return { value: null, stale: false };
    if (value.lower === 0 && value.upper === 0 && value.exact === 0
      && value.anchor === learnedAnchor && value.expiresAt === 0) {
      return { value: value as unknown as DimensionEvidence, stale: false };
    }
    return {
      value: Object.freeze({ lower: 0, upper: 0, exact: 0, anchor: learnedAnchor, expiresAt: 0 }),
      stale: false,
    };
  }

  if (expiresAt <= now) {
    return {
      value: learnedAnchor > fallback
        ? Object.freeze({ lower: 0, upper: 0, exact: 0, anchor: learnedAnchor, expiresAt: 0 })
        : null,
      stale: true,
    };
  }
  if (value.expiresAt === expiresAt && value.exact === exact && value.lower === lower
    && value.upper === upper && value.anchor === learnedAnchor) {
    return { value: value as unknown as DimensionEvidence, stale: false };
  }
  return {
    value: Object.freeze({ lower, upper, exact, anchor: learnedAnchor, expiresAt }),
    stale: false,
  };
}

function withResolvedAnchor(dimension: DimensionEvidence | null, fallback: number) {
  if (!dimension) return null;
  const anchor = resolvedLimit(dimension, fallback);
  if (dimension.anchor === anchor) return dimension;
  return Object.freeze({ ...dimension, anchor });
}

function makeState(previous: LearningState | null, requests: DimensionEvidence | null, tokens: DimensionEvidence | null, pressure: PressureEvidence | null = null): LearningState | null {
  if (!requests && !tokens && !pressure) return null;
  if (previous && previous.requests === requests && previous.tokens === tokens
    && (previous.pressure ?? null) === pressure) return previous;
  return Object.freeze({ version: 1, requests, tokens, ...(pressure ? { pressure } : {}) });
}

function isDimensionlessRateLimit(signal: RateSignal) {
  return signal.type === "rate_limit" && signal.dimension === "unknown";
}

function normalizeSignal(signal: RateSignal | null | undefined): RateSignal {
  if (!signal || signal.type === "none") return NO_SIGNAL;
  if (!["limits", "rate_limit", "quota", "overload"].includes(signal.type)) return NO_SIGNAL;
  return signal;
}

function readRateLimits(readHeader: (name: string) => unknown, now: number): RateLimits {
  const limits: NonNullable<RateLimits> = {};
  for (const dimension of DIMENSIONS) {
    const names = RATE_HEADERS[dimension];
    const limit = positiveInteger(firstHeader(readHeader, names.limit), 0);
    const remaining = nonNegativeNumber(firstHeader(readHeader, names.remaining), null);
    const resetAt = parseResetAt(firstHeader(readHeader, names.reset), now);
    if (limit || remaining != null || resetAt) {
      limits[dimension] = Object.freeze({ limit, remaining, resetAt });
    }
  }
  return Object.keys(limits).length ? Object.freeze(limits) : null;
}

function rateDimension(codeKey: string, limits: RateLimits): RateSignal["dimension"] {
  if (/tpm|tokens?perminute|token.*rate|rate.*token/.test(codeKey)) return "tokens";
  if (/rpm|requests?perminute|request.*rate|rate.*request/.test(codeKey)) return "requests";
  const exhausted = DIMENSIONS.filter(name => limits?.[name]?.remaining === 0);
  if (exhausted.length === 1) return exhausted[0];
  const advertised = DIMENSIONS.filter(name => (limits?.[name]?.limit || 0) > 0);
  return advertised.length === 1 ? advertised[0] : "unknown";
}

function exhaustedResetAt(limits: RateLimits, dimension: RateSignal["dimension"]) {
  if (dimension !== "unknown") return nonNegativeInteger(limits?.[dimension]?.resetAt, 0);
  const resets = DIMENSIONS
    .filter(name => limits?.[name]?.remaining === 0)
    .map(name => positiveInteger(limits?.[name]?.resetAt, 0))
    .filter(Boolean);
  return resets.length ? Math.min(...resets) : 0;
}

function hasAdvertisedLimit(limits: RateLimits) {
  return Boolean(limits?.requests?.limit || limits?.tokens?.limit);
}

function hasRateFacts(limits: RateLimits) {
  return Boolean(limits?.requests || limits?.tokens);
}

function makeSignal(type: RateSignal["type"], { dimension = "unknown", trusted = false, retryAt = 0, limits = null }: Partial<Omit<RateSignal, "type">> = {}): RateSignal {
  return Object.freeze({ type, dimension, trusted, retryAt, limits });
}

function parseResetAt(value: unknown, now: number) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const number = Number(text);
  if (Number.isFinite(number) && number >= 0) {
    if (number >= 1e12) return Math.floor(number);
    if (number >= 1e9) return Math.floor(number * 1000);
    return safeAdd(now, number * 1000);
  }
  const duration = parseDurationMs(text);
  if (duration != null) return safeAdd(now, duration);
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(now, Math.floor(dateMs)) : 0;
}

function parseDurationMs(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (text.slice(cursor, match.index).trim()) return null;
    const scales: Record<string, number> = { ms: 1, s: 1000, m: MINUTE_MS, h: 60 * MINUTE_MS };
    const scale = scales[match[2]];
    total += Number(match[1]) * scale;
    cursor = pattern.lastIndex;
  }
  return cursor === text.length && cursor > 0 && Number.isFinite(total) ? Math.floor(total) : null;
}

function createHeaderReader(headers: SignalInput["headers"]): (name: string) => unknown {
  if (hasHeaderReader(headers)) return name => headers.get(name);
  const entries = headers && typeof headers === "object" ? Object.entries(headers) : [];
  const normalized = new Map(entries.map(([name, value]) => [String(name).toLowerCase(), value]));
  return name => normalized.get(String(name).toLowerCase()) ?? null;
}

function toHeaders(headers: SignalInput["headers"]): HeaderReader | null {
  if (hasHeaderReader(headers)) return headers;
  try {
    return new Headers(headers && typeof headers === "object" ? Object.entries(headers).map(([name, value]) => [name, String(value)]) : []);
  } catch (_error) {
    return null;
  }
}

function firstHeader(readHeader: (name: string) => unknown, names: readonly string[]) {
  for (const name of names) {
    const value = readHeader(name);
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizePolicy(policy: RatePolicyInput | undefined): CapacityPolicy {
  const normalized = {
    windowMs: positiveInteger(policy?.windowMs, 0),
    requestsPerWindow: positiveInteger(policy?.requestsPerWindow, 0),
    tokensPerWindow: positiveInteger(policy?.tokensPerWindow, 0),
  };
  if (!normalized.windowMs || !normalized.requestsPerWindow || !normalized.tokensPerWindow) {
    throw new TypeError("provider rate fallback policy is required");
  }
  return normalized;
}

function safeAdd(left: number, right: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(left + right)));
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : fallback;
}

function nonNegativeNumber(value: unknown, fallback: null): number | null {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function hasHeaderReader(value: SignalInput['headers']): value is HeaderReader {
  return value !== null && typeof value === 'object' && typeof value.get === 'function';
}
